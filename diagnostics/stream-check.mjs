import { writeReport } from './report-output.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(process.env.BUFFETT_APP_ROOT || resolve(here, '..'));
const require = createRequire(resolve(app, 'package.json'));
const { build } = require('esbuild');
const adapterPath = resolve(app, 'lib/model-provider.ts');
const source = await readFile(adapterPath, 'utf8');
const bundled = await build({ entryPoints: [adapterPath], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { callChatCompletion, ProviderError } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network attempt: tests must supply mock fetch.'); };
const config = { name: 'Offline SSE test', baseURL: 'https://offline.invalid/v1', protocol: 'chat-completions', apiKey: 'dummy-not-a-real-key', model: 'offline-model', dailyRequestLimit: 1 };
const baseRequest = { model: 'offline-model', messages: [{ role: 'user', content: 'Offline transport test.' }], maxTokens: 400, timeoutMs: 1000, stream: true };
const encoder = new TextEncoder();
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = (content, finish = null, extra = {}) => ({ model: 'offline-model', choices: [{ index: 0, delta: { ...(content !== undefined ? { content } : {}), ...extra }, finish_reason: finish }] });
const usage = { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 };
const valid = (text = 'A complete answer.') => event(delta(text)) + event(delta(undefined, 'stop')) + event({ choices: [], usage }) + event('[DONE]');
const report = { version: 'sse-adapter-offline-1', adapterSha256: createHash('sha256').update(source).digest('hex'), checkedAt: new Date().toISOString(), networkCalls: 0, providerCalls: 0, tests: [], scope: 'Actual TypeScript transport bundled with esbuild; mocked fetch and ReadableStream only. No model quality, latency or provider-compatibility claim.' };

function responseFromBytes(bytes, { chunkSizes = [bytes.length], hold = false, contentType = 'text/event-stream', headers = {} } = {}) {
  let offset = 0, index = 0, cancellations = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        const size = chunkSizes[index++ % chunkSizes.length];
        controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
      } else if (!hold) controller.close();
    },
    cancel() { cancellations++; },
  });
  return { response: new Response(body, { headers: { 'Content-Type': contentType, ...headers } }), cancelled: () => cancellations };
}
function stream(text, options) { return responseFromBytes(encoder.encode(text), options); }
async function run(stub, overrides = {}, inspect) {
  let attempts = 0;
  const result = await callChatCompletion(config, { ...baseRequest, ...overrides }, async (url, options) => {
    attempts++;
    assert.equal(url, 'https://offline.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, overrides.stream ?? true);
    if (body.stream) assert.deepEqual(body.stream_options, { include_usage: true });
    inspect?.(options, body);
    return stub.response;
  });
  assert.equal(attempts, 1);
  return result;
}
async function errorCode(stub, code, overrides, inspect) {
  await assert.rejects(() => run(stub, overrides, inspect), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('dummy-not-a-real-key'));
    return true;
  });
}
async function check(name, callback) {
  try { await callback(); report.tests.push({ name, passed: true }); }
  catch (error) { report.tests.push({ name, passed: false, failure: error.message }); }
}

try {
  await check('cross-origin 302 is cancelled without reading its body or forwarding credentials', async () => {
    let attempts=0, bodyReads=0, cancellations=0;
    const body=new ReadableStream({pull(){bodyReads++;},cancel(){cancellations++;}},{highWaterMark:0});
    const response=new Response(body,{status:302,headers:{Location:'https://other-origin.invalid/credential-trap','Content-Type':'text/html'}});
    await assert.rejects(()=>callChatCompletion(config,baseRequest,async(url,options)=>{
      attempts++;
      assert.equal(url,'https://offline.invalid/v1/chat/completions');
      assert.equal(options.redirect,'manual');
      assert.equal(new Headers(options.headers).get('Authorization'),'Bearer dummy-not-a-real-key');
      return response;
    }),error=>{
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code,'upstream');
      assert.equal(error.httpStatus,302);
      assert.doesNotMatch(error.message,/credential-trap|dummy-not-a-real-key/);
      return true;
    });
    assert.equal(attempts,1);
    assert.equal(bodyReads,0);
    assert.equal(cancellations,1);
  });
  await check('proper stop + DONE returns exact content and usage-only final event', async () => {
    const output = await run(stream(valid()));
    assert.equal(output.text, 'A complete answer.');
    assert.deepEqual(output.usage, { inputTokens: 17, outputTokens: 5, totalTokens: 22, reported: true });
    assert.equal(output.reportedModel, 'offline-model');
  });
  await check('one-byte chunks preserve split UTF-8 and every event boundary', async () => {
    const output = await run(stream(valid('现金流 — café 📚'), { chunkSizes: [1] }));
    assert.equal(output.text, '现金流 — café 📚');
  });
  await check('CRLF event boundaries survive arbitrary transport splits', async () => {
    const output = await run(stream(valid('CRLF works.').replaceAll('\n', '\r\n'), { chunkSizes: [1, 3, 7, 2, 11] }));
    assert.equal(output.text, 'CRLF works.');
  });
  await check('SSE comments/empty events and multiline JSON data are accepted', async () => {
    const json = JSON.stringify(delta('Multiline works.'), null, 2).split('\n').map(line => `data: ${line}`).join('\n');
    const text = ': keepalive\n\nevent: message\ndata:\n\n' + json + '\n\n' + event(delta(undefined, 'stop')) + event('[DONE]');
    assert.equal((await run(stream(text, { chunkSizes: [9] }))).text, 'Multiline works.');
  });
  await check('no usage remains unknown rather than zero', async () => {
    const output = await run(stream(event(delta('Answer', 'stop')) + event('[DONE]')));
    assert.deepEqual(output.usage, { inputTokens: null, outputTokens: null, totalTokens: null, reported: false });
  });
  await check('inconsistent reported usage is not marked trustworthy', async () => {
    const text = event(delta('Answer', 'stop')) + event({ choices: [], usage: { ...usage, total_tokens: 100 } }) + event('[DONE]');
    assert.equal((await run(stream(text))).usage.reported, false);
  });
  await check('missing DONE is rejected after otherwise proper stop', () => errorCode(stream(event(delta('Answer', 'stop'))), 'invalid_response'));
  await check('DONE without stop is rejected', () => errorCode(stream(event(delta('Answer')) + event('[DONE]')), 'invalid_response'));
  await check('empty content with stop and DONE is rejected', () => errorCode(stream(event(delta('', 'stop')) + event('[DONE]')), 'invalid_response'));
  await check('explicit output truncation is rejected', () => errorCode(stream(event(delta('Incomplete', 'length')) + event('[DONE]')), 'truncated'));
  await check('tool_calls delta is rejected', () => errorCode(stream(event(delta(undefined, null, { tool_calls: [{ id: 'offline-tool' }] }))), 'invalid_response'));
  await check('legacy function_call delta is rejected', () => errorCode(stream(event(delta(undefined, null, { function_call: { name: 'offline' } }))), 'invalid_response'));
  await check('multiple choices in one event are rejected', () => errorCode(stream(event({ choices: [{ index: 0, delta: { content: 'A' } }, { index: 1, delta: { content: 'B' } }] })), 'invalid_response'));
  await check('nonzero choice index is rejected', () => errorCode(stream(event({ choices: [{ index: 1, delta: { content: 'A' } }] })), 'invalid_response'));
  await check('provider content-filter refusal is rejected', () => errorCode(stream(event(delta(undefined, 'content_filter'))), 'refusal'));
  await check('content emitted after stop is rejected', () => errorCode(stream(event(delta('First', 'stop')) + event(delta('Second')) + event('[DONE]')), 'invalid_response'));
  await check('extra data event after DONE in same transport chunk is rejected', () => errorCode(stream(valid() + event(delta('Unexpected'))), 'invalid_response'));
  await check('malformed JSON event is rejected', () => errorCode(stream('data: {invalid}\n\n'), 'invalid_response'));
  await check('invalid UTF-8 is an invalid response rather than a network failure', async () => {
    const prefix = encoder.encode('data: {"choices":');
    const bytes = new Uint8Array([...prefix, 0xff, 0xfe]);
    await errorCode(responseFromBytes(bytes), 'invalid_response');
  });
  await check('output character bound rejects oversized generated text', () => errorCode(stream(event(delta('x'.repeat(100001), 'stop')) + event('[DONE]')), 'response_too_large'));
  await check('total transport byte bound rejects oversized SSE metadata/comments', async () => {
    const stub = stream(': ' + 'x'.repeat(2097152) + '\n\n', { chunkSizes: [65536], hold: true });
    await errorCode(stub, 'response_too_large'); assert.ok(stub.cancelled() >= 1);
  });
  await check('caller cancellation stops stalled stream reader', async () => {
    const controller = new AbortController(); const stub = stream(event(delta('Partial')), { hold: true });
    const timer = setTimeout(() => controller.abort(), 5);
    try { await errorCode(stub, 'cancelled', { signal: controller.signal }); assert.ok(stub.cancelled() >= 1); }
    finally { clearTimeout(timer); }
  });
  await check('transport timeout stops stalled reader', async () => {
    const stub = stream(event(delta('Partial')), { hold: true });
    await errorCode(stub, 'timeout', { timeoutMs: 10 }); assert.ok(stub.cancelled() >= 1);
  });
  await check('cancellation retains usage already reported by stream', async () => {
    const controller = new AbortController(); const stub = stream(event({ choices: [], usage }) + event(delta('Partial')), { hold: true });
    const timer = setTimeout(() => controller.abort(), 5);
    try {
      await assert.rejects(() => run(stub, { signal: controller.signal }), error => {
        assert.equal(error.code, 'cancelled');
        assert.deepEqual(error.usage, { inputTokens: 17, outputTokens: 5, totalTokens: 22, reported: true });
        return true;
      });
    } finally { clearTimeout(timer); }
  });
  await check('normal JSON fallback works even when request opted into stream', async () => {
    const payload = { model: 'offline-json-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'JSON fallback.' } }], usage };
    const stub = stream(JSON.stringify(payload), { contentType: 'application/json', chunkSizes: [2, 5, 11] });
    const output = await run(stub); assert.equal(output.text, 'JSON fallback.'); assert.equal(output.usage.totalTokens, 22);
  });
  await check('normal nonstream JSON request preserves compatibility', async () => {
    const payload = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Nonstream.' } }], usage };
    const output = await run(stream(JSON.stringify(payload), { contentType: 'application/json' }), { stream: false });
    assert.equal(output.text, 'Nonstream.');
  });
} finally {
  globalThis.fetch = originalFetch;
  report.passed = report.tests.filter(test => test.passed).length;
  report.failed = report.tests.filter(test => !test.passed).length;
  await writeReport('stream-check-report.json', report);
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, failures: report.tests.filter(test => !test.passed), report: 'test-results/backend/stream-check-report.json' }, null, 2));
  if (report.failed) process.exitCode = 1;
}
