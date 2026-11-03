import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "../../db";
import { sessions } from "../../db/schema";
import { rejectCrossSiteRead, RequestError } from "./http";

const COOKIE_NAME = "buffett_beta_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieToken(request: Request) {
  const values = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return TOKEN_PATTERN.test(token) ? token : null;
}

async function currentSession(request: Request) {
  const token = cookieToken(request);
  if (!token) return null;
  const id = await hashToken(token);
  const [session] = await getDb().select().from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, Date.now()))).limit(1);
  return session ?? null;
}

export async function getOrCreateSession(request: Request) {
  rejectCrossSiteRead(request);
  const existing = await currentSession(request);
  if (existing) return { session: existing, cookie: null };
  const token = randomToken();
  const now = Date.now();
  const session = { id: await hashToken(token), csrfToken: randomToken(), createdAt: now, expiresAt: now + SESSION_SECONDS * 1000 };
  const db = getDb();
  await db.insert(sessions).values(session);
  // Bounded housekeeping is opportunistic; this is not a promise of timed erasure.
  const expired = await db.select({ id: sessions.id }).from(sessions).where(lt(sessions.expiresAt, now)).limit(20);
  for (const item of expired) await db.delete(sessions).where(eq(sessions.id, item.id));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
  return { session, cookie };
}

export async function requireSession(request: Request) {
  const session = await currentSession(request);
  if (!session) throw new RequestError(401, "Your session has expired. Refresh the page and try again.");
  const supplied = request.headers.get("x-csrf-token") ?? "";
  let difference = supplied.length ^ session.csrfToken.length;
  for (let i = 0; i < session.csrfToken.length; i++) {
    difference |= session.csrfToken.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
  }
  if (difference !== 0) throw new RequestError(403, "Your security token has expired. Refresh the page and try again.");
  return session;
}
