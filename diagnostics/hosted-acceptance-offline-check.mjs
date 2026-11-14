/** No network or paid calls. Uses injected fetch and temporary reports only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAcceptance } from "./hosted-acceptance.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "buffett-hosted-acceptance-"));
const token = "offline-service-credential-placeholder", csrf = "a".repeat(64), cookie = "b".repeat(64);
const origin = "https://buffett-question-book-beta.idleuser123456789.chatgpt.site";
const freezePath = path.join(directory, "freeze.json");
await fs.writeFile(freezePath, JSON.stringify({ siteSourceCommit: "offline-fixture", realTestPlan: {
  maximumProviderAttempts: 10, questions: ["how to evaluate a stock", "Competence fixture?", "Integrity fixture?", "How do I bake sourdough bread?"] } }));
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function result(question, outside = false) {
  const done = { status: "completed", durationMs: 1 }, unused = { status: "not_started", durationMs: null };
  return { id: "rq_fixture", question, kind: outside ? "unavailable" : "generated", elapsedMs: 8,
    timings: { version: 1, scope: "original_preparation", planning: done, retrieval: outside ? unused : done, writer: outside ? unused : done, reviewer: outside ? unused : done, totalMs: 8 },
    ...(outside ? { message: "This question was not matched to this site's Buffett and Munger source material. No answer was generated. Please ask about their ideas or historical discussions." }
      : { answer: { title: "Fixture", lead: "Source-backed fixture. [[P01]]", sections: [], reference_keys: ["P01"] }, references: { P01: { label: "Fixture" } }, generation: { humanReviewed: false, cached: false } }) };
}
function mock(mode = "ok") {
  const calls = [], bodies = [];
  let polled = false;
  return { calls, bodies, fetch: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method });
    assert.equal(url.origin, origin); assert.equal(options.redirect, "manual"); assert.equal(options.keepalive, true);
    assert.equal(options.headers.get("OAI-Sites-Authorization"), `Bearer ${token}`);
    if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } });
    if (url.pathname === "/api/session") return reply({ csrfToken: csrf, generationEnabled: true, feedbackEnabled: true, contentVersion: "fixture" }, 200,
      { "Set-Cookie": `buffett_beta_session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Secure` });
    assert.equal(options.headers.get("Cookie"), `buffett_beta_session=${cookie}`);
    assert.equal(options.headers.get("Origin"), origin); assert.equal(options.headers.get("X-CSRF-Token"), csrf);
    bodies.push(options.body);
    const body = JSON.parse(options.body);
    if (mode === "network") throw new Error(`Do not expose ${token}`);
    if (mode === "unavailable") return reply({ id: "rq_failed", question: body.question, kind: "unavailable", message: "The draft failed its source check.", elapsedMs: 9 });
    if (mode === "echo") return reply({ id: "rq_failed", question: body.question, kind: "unavailable", message: token, elapsedMs: 9 });
    if (mode === "poll" && !polled) { polled = true; return reply({ id: "rq_fixture", question: body.question, kind: "processing", retryAfterMs: 2 }, 202); }
    return reply(result(body.question, body.question === "How do I bake sourdough bread?"), 200, { "Server-Timing": "request;dur=4" });
  } };
}
const checks = [];
async function run(name, mode, options = {}) {
  const m = mock(mode), reportPath = path.join(directory, `${name}.json`);
  const summary = await runAcceptance({ token, mode: options.probe ? "probe" : "run" }, { fetch: m.fetch, sleep: async () => {}, freezePath, reportPath });
  const text = await fs.readFile(reportPath, "utf8"), report = JSON.parse(text);
  assert.ok(!text.includes(token) && !text.includes(csrf) && !text.includes(cookie));
  return { m, summary, report, reportPath };
}
try {
  let test = await run("probe", "ok", { probe: true });
  assert.equal(test.m.calls.length, 1); assert.equal(test.summary.uniqueSubmissions, 0); checks.push("probe makes only session request and stores no credential");
  test = await run("success", "poll");
  assert.equal(test.summary.status, "completed_pending_semantic_and_ledger_review");
  assert.equal(test.summary.uniqueSubmissions, 4); assert.equal(test.m.calls.length, 6);
  assert.equal(test.m.bodies[0], test.m.bodies[1]); assert.equal(new Set(test.m.bodies.map(body => JSON.parse(body).requestId)).size, 4);
  assert.equal(test.report.plan.questions[0], "how to pick up stocks");
  assert.equal(test.report.results[0].responses.at(-1).result.timings.totalMs, 8);
  checks.push("four fixed questions, identical processing poll, exact original timings retained");
  let extraCalls = 0;
  await assert.rejects(runAcceptance({ token, mode: "run" }, { fetch: async () => { extraCalls++; }, freezePath, reportPath: test.reportPath }), /report_exists_no_requests_made/);
  assert.equal(extraCalls, 0); checks.push("existing report blocks rerun before any request");
  test = await run("unavailable", "unavailable");
  assert.equal(test.m.calls.length, 2); assert.equal(test.summary.failure.type, "answer_unavailable");
  assert.equal(test.report.results[0].responses[0].result.message, "The draft failed its source check."); checks.push("failed source check is saved exactly and stops remaining questions");
  test = await run("redirect", "redirect");
  assert.equal(test.m.calls.length, 1); assert.equal(test.summary.failure.type, "redirect_refused"); checks.push("redirect refused without a second fetch");
  test = await run("network", "network");
  assert.equal(test.m.calls.length, 2); assert.equal(test.summary.failure.type, "ambiguous_post_network_error_no_retry"); checks.push("ambiguous POST failure never retries and never exposes raw error");
  test = await run("echo", "echo");
  assert.equal(test.m.calls.length, 2); assert.equal(test.summary.failure.type, "credential_echo_not_saved");
  assert.equal(test.report.results[0].responses.length, 0); checks.push("credential echo is rejected before storing response");
  process.stdout.write(JSON.stringify({ passed: true, networkCalls: 0, checks }, null, 2) + "\n");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
