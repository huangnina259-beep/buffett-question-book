import { MAX_QUOTE_PUNCTUATION_NORMALIZATIONS, MAX_QUOTE_PUNCTUATION_TEXT_LENGTH } from "../pilot-types";
/** Server-only paid inference. One planner/writer/reviewer pipeline per session-scoped cache key. */
import { env } from "cloudflare:workers";
import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { generationBudget, generationJobs } from "../../db/schema";
import { buildGenerationPrompt, parseGenerationResponse, GENERATION_PROMPT_VERSION } from "../generation-prompt";
import { LIVE_EVIDENCE_VERSION } from "../retrieved-evidence";
import { buildQueryPlanPrompt, parseQueryPlanResponse, QUERY_PLAN_VERSION } from "../query-plan";
import { GenerationValidationError, type GeneratedAnswer } from "../generation-contract";
import { buildGroundingReviewPrompt, parseGroundingReview, GROUNDING_REVIEW_VERSION } from "../grounding-review";
import { callChatCompletion, ProviderError, type ProviderUsage, type ChatMessage } from "../model-provider";
import { readProviderConfig, type ProviderConfig } from "../provider-config";
import type { PilotResult, GenerationTimings, GenerationStageTiming } from "../pilot-types";

export const QUERY_PLAN_TIMEOUT_MS = 15_000;
export const GENERATION_TIMEOUT_MS = 60_000;
export const GROUNDING_REVIEW_TIMEOUT_MS = 45_000;
export const GENERATION_LEASE_MS = 135_000;
const MAX_PLAN_OUTPUT_TOKENS = 512;
const MAX_PLAN_REQUEST_BYTES = 12_000;
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
export type GenerationPayload = Pick<PilotResult, "kind" | "answer" | "references" | "message" | "retryAfterMs" | "generation" | "timings">;

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
function requestBytesFor(model: string, messages: ChatMessage[], maxTokens: number, enableThinking: boolean) {
  return new TextEncoder().encode(JSON.stringify({ model, messages, max_tokens: maxTokens,
    stream: true, stream_options: { include_usage: true }, response_format: { type: "json_object" },
    chat_template_kwargs: { enable_thinking: enableThinking }, ...(enableThinking ? { reasoning_effort: "low" } : {}) })).byteLength;
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
class QueryPlanValidationError extends Error {}
class EvidencePreparationError extends Error {}
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
type PrivateDiagnosticInput = {
  model: string;
  failureCode: string | null;
  planner: ReturnType<typeof parseQueryPlanResponse> | null;
  selection: { bundleHash: string; contextIds: string[] } | null;
  draft: GeneratedAnswer | null;
  groundingVerdict: ReturnType<typeof parseGroundingReview> | null;
  stageUsage: Record<"planning" | "writer" | "reviewer", { attempted: boolean; usage: ProviderUsage | null }>;
};
/** Private storage only. Retain parsed values, never prompts, raw reasoning or credentials. */
export function serializeGenerationDiagnostics(input: PrivateDiagnosticInput, providerSecret: string): string {
  const retention: { completeWithinScope: boolean; omittedFields: { field: string; reason: string; originalUtf8Bytes?: number }[]; redactedFields: string[] } = {
    completeWithinScope: true, omittedFields: [], redactedFields: [],
  };
  const redact = (value: unknown, field: string): unknown => {
    if (typeof value === "string") {
      if (providerSecret && value.includes(providerSecret)) {
        retention.completeWithinScope = false;
        retention.redactedFields.push(field);
        return value.split(providerSecret).join("[REDACTED_PROVIDER_CREDENTIAL]");
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item, i) => redact(item, `${field}[${i}]`));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, field ? `${field}.${key}` : key)]));
    return value;
  };
  // Explicit projection prevents accidental future addition of raw provider data.
  const stage = (value: PrivateDiagnosticInput["stageUsage"]["writer"]) => ({
    attempted: value.attempted,
    usage: value.attempted ? { inputTokens: value.usage?.inputTokens ?? null, outputTokens: value.usage?.outputTokens ?? null,
      totalTokens: value.usage?.totalTokens ?? null, reported: value.usage?.reported === true } : null,
  });
  const draft = input.draft ? { title: input.draft.title, lead: input.draft.lead, sections: input.draft.sections, reference_keys: input.draft.reference_keys,
    ...(input.draft.prompt !== undefined ? { prompt: input.draft.prompt } : {}),
    ...(input.draft.prompt_refs !== undefined ? { prompt_refs: input.draft.prompt_refs } : {}),
    ...(input.draft.next !== undefined ? { next: input.draft.next } : {}),
  } : null;
  const parsed = redact({ model: input.model, failureCode: input.failureCode,
    planner: input.planner ? { inScope: input.planner.inScope, queries: input.planner.queries, usePreviousQuestion: input.planner.usePreviousQuestion } : null,
    selection: input.selection ? { bundleHash: input.selection.bundleHash, contextIds: input.selection.contextIds } : null,
    draft, groundingVerdict: input.groundingVerdict ? { supported: input.groundingVerdict.supported, issues: input.groundingVerdict.issues, issueCount: input.groundingVerdict.issues.length } : null,
    stageUsage: { planning: stage(input.stageUsage.planning), writer: stage(input.stageUsage.writer), reviewer: stage(input.stageUsage.reviewer) },
  }, "") as Record<string, unknown>;
  const record: Record<string, unknown> = { schemaVersion: 1, scope: "private_parsed_generation_diagnostics",
    versions: { planner: QUERY_PLAN_VERSION, writer: GENERATION_PROMPT_VERSION, reviewer: GROUNDING_REVIEW_VERSION, evidence: LIVE_EVIDENCE_VERSION }, retention, ...parsed };
  const encode = () => JSON.stringify(record);
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const omit = (field: "draft" | "groundingVerdict" | "planner" | "selection") => {
    if (record[field] === null) return;
    const originalUtf8Bytes = bytes(JSON.stringify(record[field]));
    if (field === "groundingVerdict") {
      const verdict = record[field] as { supported: boolean; issueCount: number; issues: unknown };
      record[field] = { supported: verdict.supported, issueCount: verdict.issueCount, issues: null };
      retention.omittedFields.push({ field: "groundingVerdict.issues", reason: "storage_byte_limit", originalUtf8Bytes });
    } else {
      record[field] = null;
      retention.omittedFields.push({ field, reason: "storage_byte_limit", originalUtf8Bytes });
    }
    retention.completeWithinScope = false;
  };
  for (const field of ["draft", "groundingVerdict", "planner", "selection"] as const) {
    if (bytes(encode()) <= MAX_DIAGNOSTIC_BYTES) break;
    omit(field);
  }
  let encoded = encode();
  // Defensive fallback must not prevent saving the public result or imply that
  // a complete replay record survived an unexpected shape/size expansion.
  if (bytes(encoded) > MAX_DIAGNOSTIC_BYTES) encoded = JSON.stringify({ schemaVersion: 1, scope: record.scope,
    retention: { completeWithinScope: false, omittedFields: [{ field: "record", reason: "storage_byte_limit" }], redactedFields: [] } });
  return encoded;
}
const unavailable = (message: string): GenerationPayload => ({ kind: "unavailable", message });
/** An interrupted worker has no trustworthy completed stage measurements. */
export function unknownGenerationTimings(): GenerationTimings {
  const unknown = (): GenerationStageTiming => ({ status: "unknown", durationMs: null });
  return { version: 1, scope: "original_preparation", planning: unknown(), retrieval: unknown(), writer: unknown(), reviewer: unknown(), totalMs: null };
}
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
  const result = { ...unavailable("This answer did not finish. Please rephrase your question to start a new attempt."), timings: unknownGenerationTimings() };
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
  const runStarted = performance.now();
  const untouched = (): GenerationStageTiming => ({ status: "not_started", durationMs: null });
  const timings: GenerationTimings = { version: 1, scope: "original_preparation", planning: untouched(), retrieval: untouched(), writer: untouched(), reviewer: untouched(), totalMs: null };
  const elapsed = (start: number) => Math.max(0, Math.round(performance.now() - start));
  const finish = (payload: GenerationPayload): GenerationPayload => ({ ...payload, timings: { ...timings, totalMs: elapsed(runStarted) } });
  const measureCall = async (stage: "planning" | "writer" | "reviewer", call: () => ReturnType<typeof callChatCompletion>) => {
    const started = performance.now();
    try { const response = await call(); timings[stage]!.status = "completed"; return response; }
    catch (error) { timings[stage]!.status = "failed"; throw error; }
    finally { timings[stage]!.durationMs = elapsed(started); }
  };
  let settings: LiveConfig | null;
  try { settings = config(); } catch { return finish(unavailable("The answer service is not configured correctly. The reviewed answers remain available.")); }
  if (!settings) return finish(unavailable("Live answers are currently unavailable. You can still read the reviewed questions."));
  const model = settings.provider.model;
  // The job is claimed before query planning. A duplicate cannot start another
  // paid planner merely because retrieval has not finished yet.
  const id = await digest(JSON.stringify([input.sessionId, input.question.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "), input.previousQuestion ?? null, input.previousIdentity ?? null, input.previousAnswerText ?? null, LIVE_EVIDENCE_VERSION, QUERY_PLAN_VERSION, MAX_PLAN_OUTPUT_TOKENS, QUERY_PLAN_TIMEOUT_MS, GENERATION_PROMPT_VERSION, GROUNDING_REVIEW_VERSION, MAX_REVIEW_OUTPUT_TOKENS, GROUNDING_REVIEW_TIMEOUT_MS, model]));
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
    const failure = { ...unavailable("This answer did not finish. No answer was published. Please rephrase the question to start a new attempt."), timings: unknownGenerationTimings() };
    await db.update(generationJobs).set({ state: "unavailable", responseJson: JSON.stringify(failure), failureCode: "expired_processing", finishedAt: Date.now() })
      .where(and(eq(generationJobs.id, id), eq(generationJobs.state, "processing")));
    return failure;
  }
  let plannerUsage: ProviderUsage | undefined;
  let writerUsage: ProviderUsage | undefined;
  let reviewerUsage: ProviderUsage | undefined;
  let plannerAttempted = false;
  let writerAttempted = false;
  let reviewerAttempted = false;
  let diagnosticPlan: PrivateDiagnosticInput["planner"] = null;
  let diagnosticSelection: PrivateDiagnosticInput["selection"] = null;
  let diagnosticDraft: PrivateDiagnosticInput["draft"] = null;
  let diagnosticVerdict: PrivateDiagnosticInput["groundingVerdict"] = null;
  let reservedAmount = 0;
  let failureCode: string | null = null;
  let result: GenerationPayload;
  const planningUnavailable = () => unavailable("The question could not be prepared for source search. No answer was generated. Please ask a more focused question.");
  const reserveStage = async (bytes: number, tokens: number) => {
    const amount = reservedMicroCny(bytes, tokens);
    if (!await reserve(settings, amount)) return false;
    reservedAmount += amount;
    // Persist each permanent reservation before the corresponding network call.
    await db.update(generationJobs).set({ reservedMicroCny: reservedAmount }).where(eq(generationJobs.id, id));
    return true;
  };
  try {
    result = await (async (): Promise<GenerationPayload> => {
      const plannerMessages = buildQueryPlanPrompt(input.question, input.previousQuestion);
      const plannerBytes = requestBytesFor(model, plannerMessages, MAX_PLAN_OUTPUT_TOKENS, false);
      if (plannerBytes > MAX_PLAN_REQUEST_BYTES) { failureCode = "planning_input_limit"; return planningUnavailable(); }
      if (!await reserveStage(plannerBytes, MAX_PLAN_OUTPUT_TOKENS)) {
        failureCode = "planning_budget";
        return unavailable("This private trial has reached its shared answer budget. The reviewed answers and your saved history remain available.");
      }
      plannerAttempted = true;
      const planned = await measureCall("planning", () => callChatCompletion(settings.provider, { model, messages: plannerMessages,
        maxTokens: MAX_PLAN_OUTPUT_TOKENS, timeoutMs: QUERY_PLAN_TIMEOUT_MS, stream: true, jsonObject: true, enableThinking: false, signal: input.signal }));
      plannerUsage = planned.usage;
      let plan;
      try { plan = parseQueryPlanResponse(planned.text); } catch { throw new QueryPlanValidationError(); }
      diagnosticPlan = plan;
      if (!plan.inScope) {
        failureCode = "out_of_scope";
        return unavailable("This question was not matched to this site's Buffett and Munger source material. No answer was generated. Please ask about their ideas or historical discussions.");
      }
      const retrievalStarted = performance.now();
      let prepared: ReturnType<typeof buildGenerationPrompt>;
      try {
        // Planner terms guide retrieval only; they are never answer evidence.
        prepared = buildGenerationPrompt(input.question, input.previousQuestion, input.previousAnswerText, { queries: plan.queries, usePreviousQuestion: plan.usePreviousQuestion });
        diagnosticSelection = { bundleHash: prepared.evidence.bundleHash, contextIds: [...prepared.evidence.contextIds] };
        timings.retrieval.status = "completed";
      } catch { timings.retrieval.status = "failed"; throw new EvidencePreparationError(); }
      finally { timings.retrieval.durationMs = elapsed(retrievalStarted); }
      if (!prepared.evidence.contextIds.length) { failureCode = "retrieval_empty"; return unavailable("I could not find relevant original passages for this question in the indexed collection. Please ask a more focused question."); }
      const requestBytes = requestBytesFor(model, prepared.messages, MAX_OUTPUT_TOKENS, true);
      if (requestBytes > MAX_REQUEST_BYTES) { failureCode = "writer_input_limit"; return unavailable("The relevant source material exceeds this trial's reading limit. Please ask a more focused question."); }
      if (!await reserveStage(requestBytes, MAX_OUTPUT_TOKENS)) {
        failureCode = "global_budget";
        return unavailable("This private trial has insufficient shared allowance to prepare an answer. The reviewed answers and your saved history remain available.");
      }
      writerAttempted = true;
      const response = await measureCall("writer", () => callChatCompletion(settings.provider, { model, messages: prepared.messages,
        maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: GENERATION_TIMEOUT_MS, stream: true, jsonObject: true, enableThinking: true, reasoningEffort: "low", signal: input.signal }));
      writerUsage = response.usage;
      const parsed = parseGenerationResponse(response.text, prepared);
      if ("unavailable" in parsed) {
        failureCode = "evidence_gap";
        return unavailable("The selected sources do not support a sufficiently complete answer to this question. Please ask a more focused question or read the original references in a reviewed answer.");
      }
      diagnosticDraft = parsed.answer;
      const references = Object.fromEntries(parsed.answer.reference_keys.map((key) => {
        const metadata = prepared.evidence.publicReferences[key];
        const text = prepared.evidence.referencesForValidation[key].text;
        if (!metadata) throw new GenerationValidationError("references");
        return [key, { ...metadata, ...(text.length <= 6000 ? { excerpt: text } : {}) }];
      }));
      const normalizations = parsed.checks.normalizations;
      if (normalizations.length > MAX_QUOTE_PUNCTUATION_NORMALIZATIONS || normalizations.some((item) =>
        item.before.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH || item.after.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH)) throw new GenerationValidationError("length");
      const reviewPrompt = buildGroundingReviewPrompt(input.question, parsed.answer, prepared);
      const reviewBytes = requestBytesFor(model, reviewPrompt.messages, MAX_REVIEW_OUTPUT_TOKENS, false);
      if (reviewBytes > MAX_REQUEST_BYTES) { failureCode = "grounding_input_limit"; return reviewUnavailable(); }
      if (!await reserveStage(reviewBytes, MAX_REVIEW_OUTPUT_TOKENS)) {
        failureCode = "grounding_budget";
        return unavailable("This private trial has insufficient shared allowance to check the draft against its sources. No answer was published. The reviewed answers remain available.");
      }
      reviewerAttempted = true;
      const reviewed = await measureCall("reviewer", () => callChatCompletion(settings.provider, { model, messages: reviewPrompt.messages,
        maxTokens: MAX_REVIEW_OUTPUT_TOKENS, timeoutMs: GROUNDING_REVIEW_TIMEOUT_MS, stream: true,
        jsonObject: true, enableThinking: false, signal: input.signal }));
      reviewerUsage = reviewed.usage;
      let verdict;
      try { verdict = parseGroundingReview(reviewed.text); } catch { throw new GroundingReviewValidationError(); }
      diagnosticVerdict = verdict;
      if (!verdict.supported || verdict.issues.length) { failureCode = "grounding_rejected"; return reviewUnavailable(); }
      return { kind: "generated", answer: parsed.answer, references,
        generation: { label: "AI-generated from selected sources", checks: parsed.checks.kind, humanReviewed: false,
          scope: `Based on ${prepared.evidence.contextIds.length} selected original contexts in the indexed collection. A separate automated pass checked source support; it may still miss errors and is not human review. Historical sources do not establish today's valuation or suitability.`, cached: false,
          ...(normalizations.length ? { quotePunctuationNormalizations: normalizations.map(({ kind, before, after, referenceKey }) => ({ kind, before, after, referenceKey })) } : {}) } };
    })();
  } catch (error) {
    if (error instanceof ProviderError) {
      if (reviewerAttempted) reviewerUsage = error.usage;
      else if (writerAttempted) writerUsage = error.usage;
      else if (plannerAttempted) plannerUsage = error.usage;
      failureCode = reviewerAttempted ? `grounding_${error.code}` : writerAttempted ? error.code : `planning_${error.code}`;
      result = reviewerAttempted ? reviewUnavailable() : writerAttempted ? unavailable(`${error.message} No answer was published. Please rephrase the question to start a new attempt.`) : planningUnavailable();
    }
    else if (error instanceof QueryPlanValidationError) { failureCode = "planning_validation"; result = planningUnavailable(); }
    else if (error instanceof EvidencePreparationError) { failureCode = "retrieval_failed"; result = unavailable("The source material could not be prepared. No answer was published."); }
    else if (error instanceof GroundingReviewValidationError) { failureCode = "grounding_validation"; result = reviewUnavailable(); }
    else if (error instanceof GenerationValidationError) { failureCode = `validation_${error.code}`; result = unavailable("The draft did not pass its required citation and format checks, so it was not published. Please try a more focused question."); }
    else { failureCode = "internal"; result = unavailable("The answer could not be completed. No answer was published."); }
  }
  result = finish(result);
  if (failureCode) console.warn("answer_unavailable", failureCode);
  const usage = aggregateUsage([...(plannerAttempted ? [plannerUsage] : []), ...(writerAttempted ? [writerUsage] : []), ...(reviewerAttempted ? [reviewerUsage] : [])]);
  const diagnosticsJson = serializeGenerationDiagnostics({ model, failureCode, planner: diagnosticPlan, selection: diagnosticSelection,
    draft: diagnosticDraft, groundingVerdict: diagnosticVerdict,
    stageUsage: { planning: { attempted: plannerAttempted, usage: plannerUsage ?? null }, writer: { attempted: writerAttempted, usage: writerUsage ?? null }, reviewer: { attempted: reviewerAttempted, usage: reviewerUsage ?? null } },
  }, settings.provider.apiKey);
  const [saved] = await db.update(generationJobs).set({ state: result.kind, responseJson: JSON.stringify(result), failureCode,
    diagnosticsJson,
    inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, usageReported: usage?.reported ?? false, finishedAt: Date.now() })
    .where(and(eq(generationJobs.id, id), eq(generationJobs.state, "processing"))).returning({ id: generationJobs.id });
  if (!saved) {
    const [job] = await db.select({ responseJson: generationJobs.responseJson }).from(generationJobs).where(eq(generationJobs.id, id)).limit(1);
    return job?.responseJson ? JSON.parse(job.responseJson) as GenerationPayload : unavailable("The answer could not be saved.");
  }
  return result;
}
