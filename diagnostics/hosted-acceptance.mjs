/**
 * Owner-private acceptance runner. Node 24; no package dependencies.
 * Usage: node diagnostics/hosted-acceptance.mjs probe|run
 * Then send one hidden stdin line: {"token":"..."}. Mode may instead be
 * supplied in that JSON. Never put a credential in argv, a file, or an env var.
 * Probe calls only /api/session. Run is exclusive-create and cannot resume;
 * an interrupted/failed POST must be inspected against the native ledger.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const ORIGIN = "https://buffett-question-book-beta.idleuser123456789.chatgpt.site";
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FREEZE = path.resolve(REPOSITORY, "../candidate-v2-freeze.json");
const REPORT = path.resolve(REPOSITORY, "../hosted-acceptance-v2.json");
const PROBE_REPORT = path.resolve(REPOSITORY, "../hosted-acceptance-v2-probe.json");
const OUTSIDE_MESSAGE = "This question was not matched to this site's Buffett and Munger source material. No answer was generated. Please ask about their ideas or historical discussions.";
const MAX_QUESTION_MS = 160_000;
const MAX_POLLS = 75;
const MAX_BODY = 2_097_152;

class AcceptanceFailure extends Error {
  constructor(type, httpStatus = null) { super(type); this.type = type; this.httpStatus = httpStatus; }
}
const requireValue = (condition, type, status) => { if (!condition) throw new AcceptanceFailure(type, status); };
const safeFailure = error => error instanceof AcceptanceFailure
  ? { type: error.type, httpStatus: error.httpStatus }
  : { type: "internal_runner_failure", httpStatus: null };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

async function hiddenInput(argumentMode) {
  requireValue(process.stdin.isTTY && typeof process.stdin.setRawMode === "function", "hidden_tty_required");
  return new Promise((resolve, reject) => {
    let input = "", done = false;
    const previousRaw = Boolean(process.stdin.isRaw);
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", receive);
      process.stdin.removeListener("end", ended);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      input = "";
      if (error) reject(error); else resolve(value);
    };
    const ended = () => finish(new AcceptanceFailure("credential_input_ended"));
    const receive = chunk => {
      const text = chunk.toString("utf8");
      if (/[\u0003\u0004]/.test(text)) return finish(new AcceptanceFailure("credential_input_cancelled"));
      input += text;
      if (Buffer.byteLength(input) > 65_536) return finish(new AcceptanceFailure("credential_input_too_large"));
      if (!/[\r\n]/.test(input)) return;
      try {
        const value = JSON.parse(input.trim());
        requireValue(object(value) && Object.keys(value).every(key => ["token", "mode"].includes(key)), "invalid_input");
        requireValue(typeof value.token === "string" && value.token.length > 0 && value.token.length < 32_768 && !/\s/.test(value.token), "invalid_input");
        requireValue(value.mode === undefined || argumentMode === undefined || value.mode === argumentMode, "conflicting_mode");
        const mode = argumentMode ?? value.mode;
        requireValue(mode === "probe" || mode === "run", "explicit_mode_required");
        finish(null, { token: value.token, mode });
      } catch { finish(new AcceptanceFailure("invalid_input")); }
    };
    const timer = setTimeout(() => finish(new AcceptanceFailure("credential_input_timeout")), 60_000);
    process.stdin.setRawMode(true);
    process.stdin.on("data", receive);
    process.stdin.once("end", ended);
    process.stdin.resume();
    process.stdout.write("Ready for hidden credential JSON on stdin.\n");
  });
}

async function jsonBody(response) {
  requireValue(response.body, "empty_response", response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new AcceptanceFailure("response_too_large", response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AcceptanceFailure("invalid_json_response", response.status); }
}

function sessionCookie(headers) {
  const matches = headers.getSetCookie().filter(line => line.startsWith("buffett_beta_session="));
  requireValue(matches.length === 1, "missing_or_duplicate_session_cookie");
  const parts = matches[0].split(";").map(part => part.trim());
  const value = parts[0].slice("buffett_beta_session=".length);
  const attributes = parts.slice(1).map(part => part.toLowerCase());
  requireValue(/^[a-f0-9]{64}$/.test(value), "invalid_session_cookie");
  requireValue(attributes.includes("httponly") && attributes.includes("secure") && attributes.includes("samesite=lax") && attributes.includes("path=/"), "session_cookie_flags");
  requireValue(!attributes.some(part => part.startsWith("domain=")), "unexpected_cookie_domain");
  return value;
}

function validateTimings(result, outside) {
  const timing = result.timings;
  requireValue(object(timing) && timing.version === 1 && timing.scope === "original_preparation" && Number.isSafeInteger(timing.totalMs) && timing.totalMs >= 0, "missing_original_timings");
  for (const stage of ["planning", "retrieval", "writer", "reviewer"]) {
    const measured = stage === "planning" || !outside;
    const value = timing[stage];
    requireValue(object(value) && value.status === (measured ? "completed" : "not_started") &&
      (measured ? Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 : value.durationMs === null), "unexpected_stage_timing");
  }
  requireValue(result.elapsedMs === timing.totalMs, "elapsed_time_differs_from_original_preparation");
}

function validateResult(result, question, outside) {
  requireValue(object(result) && typeof result.id === "string" && result.question === question, "unexpected_answer_identity");
  if (outside) {
    requireValue(result.kind === "unavailable" && result.message === OUTSIDE_MESSAGE && !result.answer, "outside_control_did_not_stop_at_planning");
    validateTimings(result, true);
    return;
  }
  requireValue(result.kind === "generated", result.kind === "unavailable" ? "answer_unavailable" : "expected_freeform_generated_answer");
  requireValue(object(result.answer) && typeof result.answer.title === "string" && typeof result.answer.lead === "string" && Array.isArray(result.answer.sections), "invalid_answer_shape");
  requireValue(Array.isArray(result.answer.reference_keys) && result.answer.reference_keys.length > 0 && object(result.references) && result.answer.reference_keys.every(key => object(result.references[key])), "missing_answer_references");
  requireValue(object(result.generation) && result.generation.humanReviewed === false && result.generation.cached === false, "unexpected_generation_label_or_cache");
  validateTimings(result, false);
}

/** Dependency injection is for offline mocked tests only; CLI has no URL/path overrides. */
export async function runAcceptance({ token, mode }, dependencies = {}) {
  requireValue(mode === "probe" || mode === "run", "explicit_mode_required");
  const fetchOne = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const freezePath = dependencies.freezePath ?? FREEZE;
  const reportPath = dependencies.reportPath ?? (mode === "probe" ? PROBE_REPORT : REPORT);
  const freezeBytes = await fs.readFile(freezePath);
  const freeze = JSON.parse(freezeBytes);
  const questions = [...freeze.realTestPlan.questions];
  requireValue(questions.length === 4 && questions[0] === "how to evaluate a stock" && questions.every(question => typeof question === "string") && freeze.realTestPlan.maximumProviderAttempts === 10, "unexpected_frozen_plan");
  questions[0] = "how to pick up stocks";
  const report = {
    version: "hosted-acceptance-v2-1", mode, status: "running", startedAt: new Date().toISOString(), origin: ORIGIN,
    sourceCommit: freeze.siteSourceCommit, freezeSha256: createHash("sha256").update(freezeBytes).digest("hex"),
    scope: "Actual hosted API outcomes and exact public answer JSON. Structural checks are not semantic or human approval; costs and call counts require native-ledger verification.",
    plan: { questions, maximumUniqueSubmissions: 4, expectedMaximumProviderAttempts: 10,
      substitution: "The frozen exact stock question selects an existing curated answer. Use the user's free-form 'how to pick up stocks' instead.",
      ledgerObservationFromCoordinator: { attempts: 9, limit: 20, observedOn: "2026-11-12", verifiedByRunner: false },
      noAutomaticRetries: true, processingPollsUseSameRequestId: true },
    requests: [], results: [], uniqueSubmissions: 0, redirectsFollowed: 0,
  };
  // This file itself is the spend guard. Never remove it or automatically
  // restart/resume a failed run. wx occurs before even the session request.
  let file;
  try { file = await fs.open(reportPath, "wx", 0o600); }
  catch (error) { throw new AcceptanceFailure(error?.code === "EEXIST" ? "report_exists_no_requests_made" : "report_create_failed"); }
  const persist = async () => {
    const data = Buffer.from(JSON.stringify(report, null, 2) + "\n");
    await file.write(data, 0, data.length, 0);
    await file.truncate(data.length);
    await file.sync();
  };
  let cookie = "", csrf = "";
  const request = async (endpoint, body, timeoutMs) => {
    requireValue(endpoint === "/api/session" || endpoint === "/api/questions", "unexpected_endpoint");
    const url = new URL(endpoint, ORIGIN);
    requireValue(url.origin === ORIGIN, "credential_origin_guard");
    const headers = new Headers({ Accept: "application/json", "OAI-Sites-Authorization": `Bearer ${token}` });
    if (cookie) headers.set("Cookie", `buffett_beta_session=${cookie}`);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json"); headers.set("Origin", ORIGIN); headers.set("X-CSRF-Token", csrf);
    }
    const row = { endpoint, method: body === undefined ? "GET" : "POST", startedAt: new Date().toISOString(), status: "started" };
    report.requests.push(row);
    await persist();
    const began = performance.now(), signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchOne(url, { method: row.method, headers, body, signal, redirect: "manual", keepalive: true, cache: "no-store" });
      row.httpStatus = response.status;
      if (response.status !== 200 && !(endpoint === "/api/questions" && response.status === 202)) {
        await response.body?.cancel().catch(() => {});
        throw new AcceptanceFailure(response.status >= 300 && response.status < 400 ? "redirect_refused" : "unexpected_http_status", response.status);
      }
      requireValue((response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"), "unexpected_content_type", response.status);
      const data = await jsonBody(response);
      const serialized = JSON.stringify(data);
      requireValue(![token, cookie, csrf].some(secret => secret && serialized.includes(secret)), "credential_echo_not_saved", response.status);
      const serverTiming = /^request;dur=([0-9]+(?:\.[0-9]+)?)$/.exec(response.headers.get("server-timing") ?? "");
      if (serverTiming) row.serverRequestMs = Number(serverTiming[1]);
      row.status = "received";
      return { response, data };
    } catch (error) {
      const failure = error instanceof AcceptanceFailure ? error : new AcceptanceFailure(body === undefined
        ? (signal.aborted ? "session_timeout" : "session_network_error")
        : (signal.aborted ? "ambiguous_post_timeout_no_retry" : "ambiguous_post_network_error_no_retry"));
      row.status = "failed"; row.failure = safeFailure(failure); throw failure;
    } finally { row.httpElapsedMs = Math.round(performance.now() - began); await persist(); }
  };
  try {
    await persist();
    const session = await request("/api/session", undefined, 20_000);
    requireValue(object(session.data) && /^[a-f0-9]{64}$/.test(session.data.csrfToken), "invalid_session_response");
    cookie = sessionCookie(session.response.headers); csrf = session.data.csrfToken;
    report.session = { generationEnabled: session.data.generationEnabled === true, contentVersion: session.data.contentVersion,
      feedbackEnabled: session.data.feedbackEnabled === true, cookieFlags: { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } };
    await persist();
    if (mode === "run") {
      requireValue(session.data.generationEnabled === true, "generation_disabled_no_submissions");
      for (let i = 0; i < questions.length; i++) {
        requireValue(report.uniqueSubmissions < 4, "unique_submission_cap");
        const question = questions[i], requestId = randomUUID();
        const body = JSON.stringify({ question, requestId });
        const entry = { question, requestId, expected: i === 3 ? "out_of_scope" : "generated", status: "submitting", responses: [] };
        report.results.push(entry); report.uniqueSubmissions++;
        await persist(); // Record attempt identity before the first possible side effect.
        const started = performance.now();
        for (let poll = 0;; poll++) {
          const remaining = MAX_QUESTION_MS - Math.ceil(performance.now() - started);
          requireValue(remaining > 0 && poll <= MAX_POLLS, "processing_deadline_no_retry");
          const { response, data } = await request("/api/questions", body, remaining);
          entry.responses.push({ httpStatus: response.status, receivedAt: new Date().toISOString(), result: data });
          await persist(); // Preserve the exact public JSON even when validation fails.
          if (response.status === 202) {
            requireValue(data.kind === "processing" && data.question === question, "unexpected_processing_response");
            const delay = Number.isFinite(data.retryAfterMs) ? Math.max(2000, Math.min(10_000, data.retryAfterMs)) : 2000;
            await sleep(delay);
            continue; // Identical serialized body and requestId; never a new inference retry.
          }
          validateResult(data, question, i === 3);
          entry.status = "passed_structural_acceptance";
          entry.httpEndToEndMs = Math.round(performance.now() - started);
          await persist();
          break;
        }
      }
    }
    report.status = mode === "probe" ? "probe_passed_no_questions_submitted" : "completed_pending_semantic_and_ledger_review";
  } catch (error) {
    report.status = "stopped"; report.failure = safeFailure(error);
    const current = report.results.at(-1);
    if (current?.status === "submitting") current.status = "stopped";
  } finally {
    report.finishedAt = new Date().toISOString();
    try { await persist(); } finally { await file.close(); token = ""; cookie = ""; csrf = ""; }
  }
  return { status: report.status, uniqueSubmissions: report.uniqueSubmissions, httpRequests: report.requests.length,
    ...(report.failure ? { failure: report.failure } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length <= 1 && (args.length === 0 || ["probe", "run"].includes(args[0])), "invalid_arguments");
    const summary = await runAcceptance(await hiddenInput(args[0]));
    process.stdout.write(JSON.stringify(summary) + "\n");
    if (summary.status === "stopped") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: "stopped", failure: safeFailure(error) }) + "\n");
    process.exitCode = 1;
  }
}
