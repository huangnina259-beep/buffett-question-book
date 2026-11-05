import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { answers, feedback } from "../../../db/schema";
import { MAX_QUOTE_PUNCTUATION_NORMALIZATIONS, MAX_QUOTE_PUNCTUATION_TEXT_LENGTH, type PilotResult, type PilotSource, type QuotePunctuationNormalization } from "../../../lib/pilot-types";
import { contentVersion, curatedAnswer, findCuratedQuestion } from "../../../lib/server/content";
import { resolveGeneration, pollGeneration, storedGeneration, GENERATION_LEASE_MS } from "../../../lib/server/generation";
import { LIVE_EVIDENCE_VERSION } from "../../../lib/retrieved-evidence";
import { allowKeys, json, readJson, rejectCrossSiteRead, RequestError, requiredText, requireSameOrigin, routeError } from "../../../lib/server/http";
import { useRequestAllowance } from "../../../lib/server/rate-limit";
import { requireSession } from "../../../lib/server/session";

type StoredRow = Pick<typeof answers.$inferSelect, "id" | "question" | "kind" | "responseJson">;
const kinds = new Set(["curated", "generated", "suggestions", "unavailable", "question_received", "processing"]);
const sourceFields = ["context_id", "context_title", "date", "date_basis", "date_kind", "event_date", "label", "paragraph_ids", "publication_date", "publisher_reading_url", "publisher_url", "report_year", "signature_date", "source_id", "speakers", "excerpt"];
const locatorFields = ["bbox", "canonical_text_character_end_exclusive", "canonical_text_character_start", "canonical_unit_id", "chapter_number", "extracted_text_character_end", "extracted_text_character_start", "geometry_block_index", "html_line_end", "html_line_start", "json_path", "paragraph", "paragraph_index", "paragraph_on_page", "physical_pdf_page", "printed_page", "source_line_ids", "timestamp_seconds", "timestamp_status", "type"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored snapshot.");
  return value as Record<string, unknown>;
}
function pick(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]));
}
function publicSource(value: unknown): PilotSource {
  const source = object(value);
  const selected = pick(source, sourceFields);
  if (Array.isArray(source.paragraphs)) selected.paragraphs = source.paragraphs.map((value) => {
    const paragraph = object(value);
    return { ...pick(paragraph, ["id", "unit_id", "speaker", "speaker_basis"]),
      ...(paragraph.locator ? { locator: pick(object(paragraph.locator), locatorFields) } : {}) };
  });
  return selected as PilotSource;
}

// Version 1 stored public results directly. Version 2 wraps them with a private
// request fingerprint. Select public fields in either format; never expose
// session identifiers, idempotency data, or original evidence text.
function storedResult(row: StoredRow): { result: PilotResult; fingerprint: string | null } {
  const stored = object(JSON.parse(row.responseJson));
  const wrapped = stored.storageVersion === 2;
  const value = wrapped ? object(stored.result) : stored;
  if (value.id !== row.id || value.question !== row.question || value.kind !== row.kind ||
      !kinds.has(String(value.kind)) || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs)) {
    throw new Error("Invalid stored snapshot.");
  }
  const result: PilotResult = { id: row.id, question: row.question,
    kind: row.kind as PilotResult["kind"], elapsedMs: value.elapsedMs };
  if (value.recorded === true) result.recorded = true;
  if (typeof value.message === "string") result.message = value.message;
  if (typeof value.retryAfterMs === "number") result.retryAfterMs = value.retryAfterMs;
  if (value.generation) {
    const generation = object(value.generation);
    result.generation = pick(generation, ["label", "checks", "humanReviewed", "scope", "cached"]) as PilotResult["generation"];
    if (generation.quotePunctuationNormalizations !== undefined) {
      const trace = generation.quotePunctuationNormalizations;
      if (!Array.isArray(trace) || trace.length > MAX_QUOTE_PUNCTUATION_NORMALIZATIONS) throw new Error("Invalid stored punctuation trace.");
      const normalizations: QuotePunctuationNormalization[] = trace.map((item) => {
        const entry = object(item);
        if (entry.kind !== "quote_terminal_punctuation_moved" ||
          typeof entry.before !== "string" || typeof entry.after !== "string" ||
          entry.before.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH || entry.after.length > MAX_QUOTE_PUNCTUATION_TEXT_LENGTH ||
          typeof entry.referenceKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry.referenceKey)) {
          throw new Error("Invalid stored punctuation trace.");
        }
        return { kind: entry.kind, before: entry.before, after: entry.after, referenceKey: entry.referenceKey };
      });
      if (result.generation && normalizations.length) result.generation.quotePunctuationNormalizations = normalizations;
    }
  }
  if (Array.isArray(value.suggestions)) result.suggestions = value.suggestions.map((item) => {
    const suggestion = object(item);
    if (["slug", "title", "short"].some((key) => typeof suggestion[key] !== "string")) throw new Error("Invalid stored reading.");
    return { slug: suggestion.slug as string, title: suggestion.title as string, short: suggestion.short as string };
  });
  if (value.answer) {
    const answer = object(value.answer);
    if (typeof answer.title !== "string" || typeof answer.lead !== "string" || !Array.isArray(answer.sections) ||
        !answer.sections.every((section) => Array.isArray(section) && section.length === 2 && section.every((text) => typeof text === "string")) ||
        !Array.isArray(answer.reference_keys) || !answer.reference_keys.every((key) => typeof key === "string")) {
      throw new Error("Invalid stored answer.");
    }
    result.answer = pick(answer, ["title", "lead", "sections", "prompt", "prompt_refs", "reference_keys", "next"]) as PilotResult["answer"];
  }
  if (value.references) result.references = Object.fromEntries(Object.entries(object(value.references)).map(([key, source]) => [key, publicSource(source)]));
  return { result, fingerprint: wrapped && typeof stored.requestFingerprint === "string" ? stored.requestFingerprint : null };
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function checkReplay(row: StoredRow, fingerprint: string) {
  const stored = storedResult(row);
  if (stored.fingerprint !== fingerprint) throw new RequestError(409, "This request ID has already been used for a different question. Start a new submission.");
  return stored.result;
}

export async function GET(request: Request) {
  try {
    rejectCrossSiteRead(request);
    const session = await requireSession(request);
    const db = getDb();
    const rows = await db.select({ id: answers.id, question: answers.question, kind: answers.kind, responseJson: answers.responseJson, createdAt: answers.createdAt })
      .from(answers).where(eq(answers.sessionId, session.id)).orderBy(desc(answers.createdAt), desc(answers.id)).limit(20);
    const results: PilotResult[] = [];
    for (const row of rows.reverse()) {
      let result = storedResult(row).result;
      if (result.kind === "processing") {
        const envelope = object(JSON.parse(row.responseJson));
        const recovered = typeof envelope.generationJobId === "string" ? await storedGeneration(session.id, envelope.generationJobId) : null;
        const payload = recovered?.payload ?? (row.createdAt + GENERATION_LEASE_MS < Date.now()
          ? { kind: "unavailable" as const, message: "This answer did not finish. Please rephrase your question to start a new attempt." } : null);
        if (payload && payload.kind !== "processing") {
          result = { id: row.id, question: row.question, ...payload, elapsedMs: Math.max(0, (recovered?.finishedAt ?? Date.now()) - row.createdAt) };
          const [saved] = await db.update(answers).set({ kind: result.kind, responseJson: JSON.stringify({ ...envelope, result }), elapsedMs: result.elapsedMs })
            .where(and(eq(answers.id, row.id), eq(answers.sessionId, session.id), eq(answers.kind, "processing"))).returning({ id: answers.id });
          if (!saved) {
            const [winner] = await db.select().from(answers).where(and(eq(answers.id, row.id), eq(answers.sessionId, session.id))).limit(1);
            if (winner) result = storedResult(winner).result;
          }
        }
      }
      results.push(result);
    }
    const ownFeedback = results.length ? await db.select({ answerId: feedback.answerId, helpful: feedback.helpful, reason: feedback.reason, comment: feedback.comment })
      .from(feedback).where(and(eq(feedback.sessionId, session.id), inArray(feedback.answerId, results.map(({ id }) => id)))) : [];
    return json({ results, feedback: Object.fromEntries(ownFeedback.map(({ answerId, ...value }) => [answerId, value])) });
  } catch (error) { return routeError(error, "Your recent questions could not be loaded. Please try again shortly."); }
}

export async function POST(request: Request) {
  const started = performance.now();
  try {
    requireSameOrigin(request);
    const payload = await readJson(request);
    allowKeys(payload, ["question", "curatedSlug", "previousAnswerId", "requestId"]);
    const question = requiredText(payload.question, "Question", 2000);
    const slug = payload.curatedSlug === undefined ? undefined : requiredText(payload.curatedSlug, "Selected answer", 100);
    const previousAnswerId = payload.previousAnswerId === undefined ? null : requiredText(payload.previousAnswerId, "Previous answer", 100);
    const requestId = payload.requestId === undefined ? null : requiredText(payload.requestId, "Request ID", 36).toLowerCase();
    if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
      throw new RequestError(400, "Request ID must be a UUID.");
    }
    const session = await requireSession(request);
    const db = getDb();
    // Scoped IDs avoid a global client-ID oracle and need no schema migration.
    const id = requestId ? `rq_${await digest(`${session.id}:${requestId}`)}` : crypto.randomUUID();
    const fingerprint = requestId ? await digest(JSON.stringify([question, slug ?? null, previousAnswerId])) : null;
    const findOwned = async () => {
      const [row] = await db.select({ id: answers.id, question: answers.question, kind: answers.kind, responseJson: answers.responseJson, createdAt: answers.createdAt })
        .from(answers).where(and(eq(answers.id, id), eq(answers.sessionId, session.id))).limit(1);
      return row;
    };
    let existingPending: PilotResult | null = null;
    let pinnedGenerationJobId: string | undefined;
    let pendingCreatedAt = Date.now();
    if (fingerprint) {
      const prior = await findOwned();
      if (prior) {
        const result = checkReplay(prior, fingerprint);
        if (result.kind !== "processing") return json(result);
        existingPending = result;
        pendingCreatedAt = prior.createdAt;
        const envelope = object(JSON.parse(prior.responseJson));
        if (typeof envelope.generationJobId === "string") pinnedGenerationJobId = envelope.generationJobId;
      }
    }
    let previousQuestion: string | undefined;
    let previousAnswerText: string | undefined;
    let previousIdentity: string | undefined;
    if (previousAnswerId) {
      const [previous] = await db.select().from(answers)
        .where(and(eq(answers.id, previousAnswerId), eq(answers.sessionId, session.id))).limit(1);
      if (!previous) throw new RequestError(404, "That earlier answer is not available in this session.");
      previousQuestion = previous.question;
      const snapshot = storedResult(previous).result;
      previousAnswerText = snapshot.answer ? JSON.stringify({ title: snapshot.answer.title, lead: snapshot.answer.lead, sections: snapshot.answer.sections }) : undefined;
      previousIdentity = `${previous.id}:${previous.contentVersion}:${await digest(previous.responseJson)}`;
    }
    const curated = findCuratedQuestion(question, slug);
    if (slug && !curated) throw new RequestError(400, "That selected answer is not available.");
    if (!existingPending) await useRequestAllowance(session.id, "questions");
    const initial: PilotResult = existingPending ?? (curated ? {
      id, kind: "curated" as const, question, ...curatedAnswer(curated),
      elapsedMs: Math.round(performance.now() - started),
    } : {
      id, kind: "processing", question,
      message: "An answer is being prepared from the selected sources.", retryAfterMs: 2000,
      elapsedMs: Math.round(performance.now() - started),
    });
    if (!existingPending) {
      const inserted = await db.insert(answers).values({
        id, sessionId: session.id, question, kind: initial.kind,
        curatedSlug: curated?.slug ?? null, previousAnswerId, contentVersion: curated ? contentVersion : LIVE_EVIDENCE_VERSION,
        responseJson: JSON.stringify({ storageVersion: 2, requestFingerprint: fingerprint, result: initial }),
        elapsedMs: initial.elapsedMs, createdAt: Date.now(),
      }).onConflictDoNothing({ target: answers.id }).returning({ id: answers.id });
      if (!inserted.length) {
      // A concurrent duplicate can win the insert. Return its persisted result,
      // never a receipt for the losing in-memory result.
        const winner = await findOwned();
        if (!winner || !fingerprint) throw new RequestError(409, "This submission could not be recorded. Start a new submission.");
        const saved = checkReplay(winner, fingerprint);
        if (saved.kind !== "processing") return json(saved);
      }
    }
    if (curated) return json(initial);
    let generationJobId: string | undefined = pinnedGenerationJobId;
    const generated = pinnedGenerationJobId ? await pollGeneration(session.id, pinnedGenerationJobId, pendingCreatedAt) : await resolveGeneration({ sessionId: session.id, question, previousQuestion, previousAnswerText, previousIdentity, signal: request.signal,
      onJob: async (jobId) => {
        generationJobId = jobId;
        const [linked] = await db.update(answers).set({ responseJson: JSON.stringify({ storageVersion: 2, requestFingerprint: fingerprint, generationJobId, result: initial }) })
          .where(and(eq(answers.id, id), eq(answers.sessionId, session.id), eq(answers.kind, "processing"),
            or(sql`json_extract(${answers.responseJson}, '$.generationJobId') is null`, sql`json_extract(${answers.responseJson}, '$.generationJobId') = ${jobId}`)))
          .returning({ id: answers.id });
        return Boolean(linked);
      },
    });
    if (generated.kind === "processing") return json({ ...initial, ...generated }, 202, { "Retry-After": "2" });
    const result: PilotResult = { id, question, ...generated, elapsedMs: Math.round(performance.now() - started) };
    const saved = await db.update(answers).set({ kind: result.kind, responseJson: JSON.stringify({ storageVersion: 2, requestFingerprint: fingerprint, generationJobId, result }), elapsedMs: result.elapsedMs })
      .where(and(eq(answers.id, id), eq(answers.sessionId, session.id), eq(answers.kind, "processing"))).returning({ id: answers.id });
    if (!saved.length) {
      const winner = await findOwned();
      if (winner) return json(storedResult(winner).result);
      throw new RequestError(503, "The answer could not be saved.");
    }
    return json(result);
  } catch (error) { return routeError(error); }
}
