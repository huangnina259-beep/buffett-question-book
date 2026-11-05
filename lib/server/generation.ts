import { MAX_QUOTE_PUNCTUATION_NORMALIZATIONS, MAX_QUOTE_PUNCTUATION_TEXT_LENGTH } from "../pilot-types";
/** Server-only paid inference. One writer/reviewer pipeline per session-scoped cache key. */
import { env } from "cloudflare:workers";
import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { generationBudget, generationJobs } from "../../db/schema";
import { buildGenerationPrompt, parseGenerationResponse, GENERATION_PROMPT_VERSION } from "../generation-prompt";
import { GenerationValidationError } from "../generation-contract";
import { buildGroundingReviewPrompt, parseGroundingReview, GROUNDING_REVIEW_VERSION } from "../grounding-review";
import { callChatCompletion, ProviderError, type ProviderUsage, type ChatMessage } from "../model-provider";
import { readProviderConfig, type ProviderConfig } from "../provider-config";
import type { PilotResult } from "../pilot-types";

export const GENERATION_TIMEOUT_MS = 60_000;
export const GROUNDING_REVIEW_TIMEOUT_MS = 45_000;
export const GENERATION_LEASE_MS = 135_000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_REVIEW_OUTPUT_TOKENS = 4096;
const MAX_REQUEST_BYTES = 120_000;
// This stable ledger ID is deliberately independent of release/prompt version.
const BUDGET_ID = "private-source-grounded-trial";
const HARD_ATTEMPTS = 20;
const HARD_BUDGET_MICRO_CNY = 5_000_000;
const VERIFIED_MODELS = new Set(["MiniMax-M3-W8A8", "Qwen3.6-35B-A3B", "Qwen3.8-Flash-Next-W8A8"]);
// Provider price list verified 2026-11-04: CNY2/input and CNY4/output per1M.
// A reservation is a conservative estimate, not an upstream billing guarantee.
const INPUT_MICRO_CNY_PER_TOKEN = 2;
const OUTPUT_MICRO_CNY_PER_TOKEN = 4;
export type GenerationPayload = Pick<PilotResult, "kind" | "answer" | "references" | "message" | "retryAfterMs" | "generation">;

type LiveConfig = { provider: ProviderConfig; attempts: number; dailyAttempts: number; microCny: number };
function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("Invalid generation limit.");
  return result;
}
export function liveConfigFrom(values: Record<string, string | undefined>): LiveConfig | null {
  const provider = readProviderConfig(values);
  if (!provider) return null;
  if (provider.protocol !== "chat-completions" || provider.baseURL !== "https://openapi.wtsht.cn/v1" || !VERIFIED_MODELS.has(provider.model)) {
    throw new Error("The trial model configuration is not verified.");
  }
  const amount = values.MODEL_TOTAL_BUDGET_CNY === undefined ? 5 : Number(values.MODEL_TOTAL_BUDGET_CNY);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5) throw new Error("Invalid generation budget.");
  return { provider, attempts: boundedInteger(values.MODEL_TOTAL_REQUEST_LIMIT, HARD_ATTEMPTS, HARD_ATTEMPTS),
    dailyAttempts: boundedInteger(String(provider.dailyRequestLimit), HARD_ATTEMPTS, HARD_ATTEMPTS),
    microCny: Math.min(HARD_BUDGET_MICRO_CNY, Math.floor(amount * 1_000_000)) };
}
function config() {
  const values = Object.fromEntries(Object.entries(env as unknown as Record<string, unknown>).filter(([, value]) => typeof value === "string"));
  return liveConfigFrom(values as Record<string, string>);
}
export function generationEnabled() {
  try { return config() !== null; } catch { return false; }
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function reservedMicroCny(messageBytes: number, maxOutputTokens = MAX_OUTPUT_TOKENS) {
  return Math.ceil(((messageBytes + 4096) * INPUT_MICRO_CNY_PER_TOKEN + maxOutputTokens * OUTPUT_MICRO_CNY_PER_TOKEN) * 1.5);
}
function requestBytesFor(model: string, messages: ChatMessage[], maxTokens: number) {
  return new TextEncoder().encode(JSON.stringify({ model, messages, max_tokens: maxTokens,
    stream: true, stream_options: { include_usage: true }, response_format: { type: "json_object" },
    chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "low" })).byteLength;
}
function aggregateUsage(stages: (ProviderUsage | undefined)[]): ProviderUsage | undefined {
  if (!stages.length) return undefined;
  if (stages.some(usage => !usage?.reported || usage.inputTokens === null || usage.outputTokens === null)) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, reported: false };
  }
  const inputTokens = stages.reduce((sum, usage) => sum + usage!.inputTokens!, 0);
  const outputTokens = stages.reduce((sum, usage) => sum + usage!.outputTokens!, 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, reported: true };
}
class GroundingReviewValidationError extends Error {}
const unavailable = (message: string): GenerationPayload => ({ kind: "unavailable", message });
const reviewUnavailable = () => unavailable("The draft could not pass its source-support check, so it was not published. Please ask a more focused question or read a reviewed answer.");
const processing = (): GenerationPayload => ({ kind: "processing", message: "An answer is being prepared from the selected sources.", retryAfterMs: 2000 });

/** History recovery reads a stored result only; it can never start inference. */
export async function storedGeneration(sessionId: string, jobId: string) {
  const [job] = await getDb().select({ responseJson: generationJobs.responseJson, finishedAt: generationJobs.finishedAt })
    .from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.sessionId, sessionId))).limit(1);
  return job?.responseJson ? { payload: JSON.parse(job.responseJson) as GenerationPayload, finishedAt: job.finishedAt } : null;
}

/** Poll a pinned job without rebuilding a prompt, creating a job, or charging. */
export async function pollGeneration(sessionId: string, jobId: string, requestCreatedAt: number): Promise<GenerationPayload> {
  const db = getDb();
  const [job] = await db.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.sessionId, sessionId))).limit(1);
  if (job?.responseJson) return JSON.parse(job.responseJson) as GenerationPayload;
  if ((job?.createdAt ?? requestCreatedAt) + GENERATION_LEASE_MS > Date.now()) return processing();
  const result = unavailable("This answer did not finish. Please rephrase your question to start a new attempt.");
  await db.update(generationJobs).set({ state: "unavailable", responseJson: JSON.stringify(result), failureCode: "expired_processing", finishedAt: Date.now() })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.state, "processing")));
  return (await storedGeneration(sessionId, jobId))?.payload ?? result;
}

async function reserve(limits: LiveConfig, amount: number) {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(generationBudget).values({ id: BUDGET_ID, attempts: 0, reservedMicroCny: 0, day, dayAttempts: 0 }).onConflictDoNothing();
  const [reserved] = await db.update(generationBudget).set({
    attempts: sql`${generationBudget.attempts} + 1`,
    reservedMicroCny: sql`${generationBudget.reservedMicroCny} + ${amount}`,
    day,
    dayAttempts: sql`case when ${generationBudget.day} = ${day} then ${generationBudget.dayAttempts} + 1 else 1 end`,
  }).where(and(eq(generationBudget.id, BUDGET_ID), lt(generationBudget.attempts, limits.attempts),
    lte(generationBudget.reservedMicroCny, limits.microCny - amount),
    or(sql`${generationBudget.day} <> ${day}`, lt(generationBudget.dayAttempts, limits.dailyAttempts))))
    .returning({ attempts: generationBudget.attempts });
  return Boolean(reserved);
}

/**
 * No automatic retry or cross-user cache. A failed attempt remains failed for
 * this session/question/evidence version; rephrasing creates a distinct request.
 * Budget counters survive session expiry and never refund failed/unknown usage.
 */
export async function resolveGeneration(input: { sessionId: string; question: string; previousQuestion?: string; previousAnswerText?: string; previousIdentity?: string; signal?: AbortSignal; onJob?: (jobId: string) => Promise<boolean> }): Promise<GenerationPayload> {
  let settings: LiveConfig | null;
  try { settings = config(); } catch { return unavailable("The answer service is not configured correctly. The reviewed answers remain available."); }
  if (!settings) return unavailable("Live answers are currently unavailable. You can still read the reviewed questions.");
  const model = settings.provider.model;
  const prepared = buildGenerationPrompt(input.question, input.previousQuestion, input.previousAnswerText);
  if (!prepared.evidence.contextIds.length) return unavailable("I could not find relevant original passages in the currently indexed topics. Try a question about business evaluation, intrinsic value, owner earnings, or the circle of competence.");
  const requestBytes = requestBytesFor(model, prepared.messages, MAX_OUTPUT_TOKENS);
  if (requestBytes > MAX_REQUEST_BYTES) return unavailable("The relevant source material exceeds this trial's reading limit. Please ask a more focused question.");
  const id = await digest(JSON.stringify([input.sessionId, input.question.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "), input.previousQuestion ?? null, input.previousIdentity ?? null, input.previousAnswerText ?? null, prepared.evidence.bundleHash, GENERATION_PROMPT_VERSION, GROUNDING_REVIEW_VERSION, MAX_REVIEW_OUTPUT_TOKENS, GROUNDING_REVIEW_TIMEOUT_MS, model]));
  if (input.onJob && !await input.onJob(id)) return processing();
  const db = getDb();
  const now = Date.now();
  const [claimed] = await db.insert(generationJobs).values({ id, sessionId: input.sessionId, state: "processing", createdAt: now })
    .onConflictDoNothing({ target: generationJobs.id }).returning({ id: generationJobs.id });
  if (!claimed) {
    const [job] = await db.select().from(generationJobs).where(and(eq(generationJobs.id, id), eq(generationJobs.sessionId, input.sessionId))).limit(1);
    if (!job) return unavailable("The answer could not be recovered. Please rephrase your question.");
    if (job.responseJson) {
      const result = JSON.parse(job.responseJson) as GenerationPayload;
      return { ...result, ...(result.generation ? { generation: { ...result.generation, cached: true } } : {}) };
    }
    if (job.createdAt + GENERATION_LEASE_MS > Date.now()) return processing();
    const failure = unavailable("This answer did not finish. No answer was published. Please rephrase the question to start a new attempt.");
    await db.update(generationJobs).set({ state: "unavailable", responseJson: JSON.stringify(failure), failureCode: "expired_processing", finishedAt: Date.now() })
      .where(and(eq(generationJobs.id, id), eq(generationJobs.state, "processing")));
    return failure;
  }
  let writerUsage: ProviderUsage | undefined;
  let reviewerUsage: ProviderUsage | undefined;
  let writerAttempted = false;
  let reviewerAttempted = false;
  let failureCode: string | null = null;
  let result: GenerationPayload;
  try {
    const amount = reservedMicroCny(requestBytes);
    if (!await reserve(settings, amount)) {
      failureCode = "global_budget";
      result = unavailable("This private trial has reached its shared answer budget. The reviewed answers and your saved history remain available.");
    } else {
      // Record the reservation before network. If this write fails, no call is
      // made and the global reservation remains conservatively consumed.
      await db.update(generationJobs).set({ reservedMicroCny: amount }).where(eq(generationJobs.id, id));
      writerAttempted = true;
      const response = await callChatCompletion(settings.provider, { model, messages: prepared.messages,
        maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: GENERATION_TIMEOUT_MS, stream: true, jsonObject: true, enableThinking: true, reasoningEffort: "low", signal: input.signal });
      writerUsage = response.usage;
      const parsed = parseGenerationResponse(response.text, prepared);
      if ("unavailable" in parsed) {
        // The model's free-form refusal is not citation-checked. Do not expose
        // it as an alternate channel for unsupported claims or advice.
        failureCode = "evidence_gap"; result = unavailable("The selected sources do not support a sufficiently complete answer to this question. Please ask a more focused question or read the original references in a reviewed answer.");
      } else {
        const references = Object.fromEntries(parsed.answer.reference_keys.map((key) => {
          const metadata = prepared.evidence.publicReferences[key];
          const text = prepared.evidence.referencesForValidation[key].text;
          if (!metadata) throw new GenerationValidationError("references");
          return [key, { ...metadata, ...(text.length <= 6000 ? { excerpt: text } : {}) }];
        }));
        const normalizations = parsed.checks.normalizations;
        if (normalizations.length > MAX_QUOTE_PUNCTUATION_NORMALIZATIONS || normalizations.some((item) =>
          item.before.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH || item.after.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH)) {
          throw new GenerationValidationError("length");
        }
        const reviewPrompt = buildGroundingReviewPrompt(input.question, parsed.answer, prepared);
        const reviewBytes = requestBytesFor(model, reviewPrompt.messages, MAX_REVIEW_OUTPUT_TOKENS);
        const reviewAmount = reservedMicroCny(reviewBytes, MAX_REVIEW_OUTPUT_TOKENS);
        if (reviewBytes > MAX_REQUEST_BYTES) {
          failureCode = "grounding_input_limit";
          result = reviewUnavailable();
        } else if (!await reserve(settings, reviewAmount)) {
          failureCode = "grounding_budget";
          result = unavailable("This private trial has insufficient shared allowance to check the draft against its sources. No answer was published. The reviewed answers remain available.");
        } else {
          // The review is a distinct paid attempt. Persist both reservations
          // before sending; neither a failed review nor unknown usage refunds it.
          await db.update(generationJobs).set({ reservedMicroCny: amount + reviewAmount }).where(eq(generationJobs.id, id));
          reviewerAttempted = true;
          const reviewed = await callChatCompletion(settings.provider, { model, messages: reviewPrompt.messages,
            maxTokens: MAX_REVIEW_OUTPUT_TOKENS, timeoutMs: GROUNDING_REVIEW_TIMEOUT_MS, stream: true,
            jsonObject: true, enableThinking: true, reasoningEffort: "low", signal: input.signal });
          reviewerUsage = reviewed.usage;
          let verdict;
          try { verdict = parseGroundingReview(reviewed.text); }
          catch { throw new GroundingReviewValidationError(); }
          if (!verdict.supported || verdict.issues.length) {
            failureCode = "grounding_rejected";
            result = reviewUnavailable();
          } else {
            result = { kind: "generated", answer: parsed.answer, references,
              generation: { label: "AI-generated from selected sources", checks: parsed.checks.kind, humanReviewed: false,
                scope: `Based on ${prepared.evidence.contextIds.length} selected original contexts in the indexed collection. A separate automated pass checked source support; it may still miss errors and is not human review. Historical sources do not establish today's valuation or suitability.`, cached: false,
                ...(normalizations.length ? { quotePunctuationNormalizations: normalizations.map(({ kind, before, after, referenceKey }) => ({ kind, before, after, referenceKey })) } : {}) } };
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      if (reviewerAttempted) reviewerUsage = error.usage;
      else if (writerAttempted) writerUsage = error.usage;
      failureCode = reviewerAttempted ? `grounding_${error.code}` : error.code;
      result = reviewerAttempted ? reviewUnavailable() : unavailable(`${error.message} No answer was published. Please rephrase the question to start a new attempt.`);
    }
    else if (error instanceof GroundingReviewValidationError) { failureCode = "grounding_validation"; result = reviewUnavailable(); }
    else if (error instanceof GenerationValidationError) { failureCode = `validation_${error.code}`; result = unavailable("The draft did not pass its required citation and format checks, so it was not published. Please try a more focused question."); }
    else { failureCode = "internal"; result = unavailable("The answer could not be completed. No answer was published."); }
  }
  const usage = aggregateUsage([...(writerAttempted ? [writerUsage] : []), ...(reviewerAttempted ? [reviewerUsage] : [])]);
  const [saved] = await db.update(generationJobs).set({ state: result.kind, responseJson: JSON.stringify(result), failureCode,
    inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, usageReported: usage?.reported ?? false, finishedAt: Date.now() })
    .where(and(eq(generationJobs.id, id), eq(generationJobs.state, "processing"))).returning({ id: generationJobs.id });
  if (!saved) {
    const [job] = await db.select({ responseJson: generationJobs.responseJson }).from(generationJobs).where(eq(generationJobs.id, id)).limit(1);
    return job?.responseJson ? JSON.parse(job.responseJson) as GenerationPayload : unavailable("The answer could not be saved.");
  }
  return result;
}
