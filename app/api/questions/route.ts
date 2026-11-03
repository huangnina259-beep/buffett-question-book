import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { answers } from "../../../db/schema";
import { contentVersion, curatedAnswer, findCuratedQuestion, relatedReading } from "../../../lib/server/content";
import { allowKeys, json, readJson, RequestError, requiredText, requireSameOrigin, routeError } from "../../../lib/server/http";
import { useRequestAllowance } from "../../../lib/server/rate-limit";
import { requireSession } from "../../../lib/server/session";

export async function POST(request: Request) {
  const started = performance.now();
  try {
    requireSameOrigin(request);
    const payload = await readJson(request);
    allowKeys(payload, ["question", "curatedSlug", "previousAnswerId"]);
    const question = requiredText(payload.question, "Question", 2000);
    const slug = payload.curatedSlug === undefined ? undefined : requiredText(payload.curatedSlug, "Selected answer", 100);
    const previousAnswerId = payload.previousAnswerId === undefined ? null : requiredText(payload.previousAnswerId, "Previous answer", 100);
    const session = await requireSession(request);
    const db = getDb();
    if (previousAnswerId) {
      const [previous] = await db.select({ id: answers.id }).from(answers)
        .where(and(eq(answers.id, previousAnswerId), eq(answers.sessionId, session.id))).limit(1);
      if (!previous) throw new RequestError(404, "That earlier answer is not available in this session.");
    }
    const curated = findCuratedQuestion(question, slug);
    if (slug && !curated) throw new RequestError(400, "That selected answer is not available.");
    await useRequestAllowance(session.id, "questions");
    const id = crypto.randomUUID();
    const result = curated ? {
      id, kind: "curated" as const, question, ...curatedAnswer(curated),
      elapsedMs: Math.round(performance.now() - started),
    } : {
      id, kind: "suggestions" as const, question,
      message: "Live answers are not enabled in this preview. Related reading—not an answer to your question.",
      suggestions: relatedReading(question),
      elapsedMs: Math.round(performance.now() - started),
    };
    await db.insert(answers).values({
      id, sessionId: session.id, question, kind: result.kind,
      curatedSlug: curated?.slug ?? null, previousAnswerId, contentVersion,
      responseJson: JSON.stringify(result), elapsedMs: result.elapsedMs, createdAt: Date.now(),
    });
    return json({ ...result, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) { return routeError(error); }
}
