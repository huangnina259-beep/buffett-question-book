import { lt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { requestWindows } from "../../db/schema";
import { RequestError } from "./http";

export async function useRequestAllowance(sessionId: string, scope: "questions" | "feedback") {
  const db = getDb();
  const now = Date.now();
  const limits = scope === "questions"
    ? [{ period: 60_000, maximum: 10 }, { period: 86_400_000, maximum: 100 }]
    : [{ period: 60_000, maximum: 20 }, { period: 86_400_000, maximum: 200 }];
  for (const { period, maximum } of limits) {
    const windowStart = Math.floor(now / period) * period;
    const incremented = await db.insert(requestWindows).values({
      sessionId, scope: `${scope}:${period}`, windowStart, count: 1,
    }).onConflictDoUpdate({
      target: [requestWindows.sessionId, requestWindows.scope, requestWindows.windowStart],
      set: { count: sql`${requestWindows.count} + 1` },
      setWhere: lt(requestWindows.count, maximum),
    }).returning({ count: requestWindows.count });
    if (!incremented.length) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + period - now) / 1000));
      throw new RequestError(429, "This preview's request limit has been reached. Please try again later.", retryAfter);
    }
  }
}
