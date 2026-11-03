import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { answers, feedback } from "../../../db/schema";
import { allowKeys, json, readJson, RequestError, requiredText, requireSameOrigin, routeError } from "../../../lib/server/http";
import { useRequestAllowance } from "../../../lib/server/rate-limit";
import { requireSession } from "../../../lib/server/session";

const reasons = new Set(["too_general", "unclear", "sources", "too_slow", "other"]);

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const payload = await readJson(request);
    allowKeys(payload, ["answerId", "helpful", "reason", "comment"]);
    const answerId = requiredText(payload.answerId, "Answer", 100);
    const helpful = payload.helpful ?? null;
    const reason = payload.reason ?? null;
    if (helpful !== null && typeof helpful !== "boolean") throw new RequestError(400, "Choose helpful or not helpful.");
    if (reason !== null && (typeof reason !== "string" || !reasons.has(reason))) throw new RequestError(400, "Choose a supported feedback reason.");
    if (typeof payload.comment !== "string" || payload.comment.length > 2000) throw new RequestError(400, "Feedback must be no longer than 2000 characters.");
    const comment = payload.comment.trim();
    if (helpful === null && reason === null && !comment) throw new RequestError(400, "Choose a rating, a reason, or add a comment.");
    const session = await requireSession(request);
    const db = getDb();
    const [owned] = await db.select({ id: answers.id }).from(answers)
      .where(and(eq(answers.id, answerId), eq(answers.sessionId, session.id))).limit(1);
    if (!owned) throw new RequestError(404, "That answer is not available in this session.");
    await useRequestAllowance(session.id, "feedback");
    const now = Date.now();
    await db.insert(feedback).values({ answerId, sessionId: session.id, helpful, reason, comment, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: feedback.answerId, set: { helpful, reason, comment, updatedAt: now } });
    return json({ saved: true });
  } catch (error) { return routeError(error, "Your feedback could not be saved. Please try again shortly."); }
}
