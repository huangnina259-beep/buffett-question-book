import { writeReport } from './report-output.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(process.env.BUFFETT_APP_ROOT || resolve(here, '..'));
const require = createRequire(resolve(app, 'package.json'));
const { build } = require('esbuild');
const migrations = await Promise.all(['0000_clear_iron_lad.sql', '0001_wandering_cloak.sql', '0002_private_generation_diagnostics.sql'].map(name => readFile(resolve(app, 'drizzle', name), 'utf8')));
let database, rejectFinalUpdate = false, mode = 'valid', fetchCount = 0, writerFetchCount = 0, reviewerFetchCount = 0, plannerFetchCount = 0, requests = [], release, entered;
class Statement {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.sql, params); }
  statement() {
    if (rejectFinalUpdate && /^update "answers" set "kind"/i.test(this.sql)) { rejectFinalUpdate = false; throw new Error('PRIVATE_INJECTED_DB_FAILURE'); }
    return database.prepare(this.sql);
  }
  async raw() { const s = this.statement(); s.setReturnArrays(true); return s.all(...this.params); }
  async all() { return { results: this.statement().all(...this.params), success: true, meta: {} }; }
  async run() { const r = this.statement().run(...this.params); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}
const values = { DB: { prepare(sql) { return new Statement(sql); } } };
globalThis.__LIVE_ENV = values;
function reset(overrides = {}) {
  database?.close(); database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys=ON');
  migrations.forEach(sql => database.exec(sql));
  for (const key of Object.keys(values)) if (key !== 'DB') delete values[key];
  Object.assign(values, { GENERATION_ENABLED:'true', MODEL_PROVIDER_NAME:'Offline test', MODEL_BASE_URL:'https://openapi.wtsht.cn/v1', MODEL_PROTOCOL:'chat-completions', MODEL_API_KEY:'offline-mock-token-no-secret', MODEL_NAME:'MiniMax-M3-W8A8', MODEL_DAILY_REQUEST_LIMIT:'20', ...overrides });
  mode='valid'; fetchCount=0; writerFetchCount=0; reviewerFetchCount=0; plannerFetchCount=0; requests=[]; rejectFinalUpdate=false;
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://openapi.wtsht.cn/v1/chat/completions');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, 'Bearer offline-mock-token-no-secret');
  fetchCount++;
  if(mode==='timed')await new Promise(resolve=>setTimeout(resolve,12));
  const request = JSON.parse(options.body); const data = JSON.parse(request.messages[1].content); const isReview=Object.hasOwn(data,'draft'),isPlan=request.max_tokens===512; requests.push({ request, data, isReview, isPlan });
  if(isPlan){
    plannerFetchCount++;assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.equal(request.reasoning_effort,undefined);assert.equal(request.response_format.type,'json_object');assert.ok(Buffer.byteLength(options.body)<=12000);
    if(mode==='plan-network')throw new Error('PRIVATE_PLANNER_ERROR');
    if(mode==='plan-hold'){entered?.();await new Promise(resolve=>{release=resolve;});}
    const outOfScope=mode==='plan-outside'||/rain tomorrow/i.test(data.question);
    const answer=mode==='plan-invalid'?{inScope:true,queries:['invented instruction'],usePreviousQuestion:false,answer:'PRIVATE_PLANNER_ANSWER'}:{inScope:!outOfScope,queries:outOfScope?[]:[data.previousQuestion&&/^Explain|^give|^why/i.test(data.question)?data.previousQuestion:data.question],usePreviousQuestion:Boolean(data.previousQuestion&&/^Explain|^give|^why/i.test(data.question))};
    return Response.json({model:request.model,choices:[{finish_reason:mode==='plan-truncated'?'length':'stop',message:{role:'assistant',content:JSON.stringify(answer)}}],...(mode==='plan-unknown'?{}:{usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})});
  }
  if(isReview){
    reviewerFetchCount++;
    assert.equal(request.max_tokens,4096);
    assert.equal(request.response_format.type,'json_object');
    assert.equal(request.reasoning_effort,undefined);
    assert.equal(request.chat_template_kwargs.enable_thinking,false);
    assert.ok(Buffer.byteLength(options.body)<=120000);
    if(mode==='review-network')throw new Error('PRIVATE_REVIEW_NETWORK_DETAIL');
    if(mode==='review-hold'){entered?.();await new Promise(resolve=>{release=resolve;});}
    const answer=mode==='review-reject'?{supported:false,issues:['PRIVATE_UNSUPPORTED_REVIEW_REASON']}:mode==='review-invalid'?{supported:true,issues:['PRIVATE_BAD_VERDICT']}:{supported:true,issues:[]};
    return Response.json({model:request.model,choices:[{finish_reason:mode==='review-truncated'?'length':'stop',message:{role:'assistant',content:JSON.stringify(answer)}}],...(mode==='review-unknown'?{}:{usage:{prompt_tokens:500,completion_tokens:40,total_tokens:540}})});
  }
  writerFetchCount++;
  if (mode === 'network') throw new Error('UPSTREAM_PRIVATE_DETAIL');
  if (mode === 'hold') { entered?.(); await new Promise(resolve => { release=resolve; }); }
  const key = data.sources[0].paragraphs[0].cite_key;
  const paragraph = { text:'This is a mechanical test double; its prose is not a semantic quality assessment.', citations:[mode === 'bad-reference' ? 'P99-999' : key] };
  const answer = mode === 'refusal' ? { unavailable:true, reason:'Buy unsupported shares immediately because they will double.' } : { title:'Mechanical test answer', lead:paragraph, sections:mode==='lead-only'?[]:[{heading:'Source relationship',paragraphs:[paragraph]}] };
  return Response.json({ model:'MiniMax-M3-W8A8', choices:[{ finish_reason:'stop', message:{role:'assistant',content:JSON.stringify(answer),tool_calls:[]} }], ...(mode==='writer-unknown'?{}:{usage:{prompt_tokens:1000,completion_tokens:120,total_tokens:1120}}) });
};
const temp = await mkdtemp(resolve(here, '.offline-'));
const report = { version:'live-v3-offline-backend-1', networkCalls:0, provider:'mock fetch only; no real key loaded', validationScope:'Real route/Drizzle/D1-like SQLite/state/parser checks; no claim of semantic answer quality.', checks:[] };
let routes;
async function check(name, fn) {
  reset();
  try { await fn(); report.checks.push({name,passed:true}); }
  catch(error) {report.checks.push({name,passed:false,failure:error.message});throw error;}
}
const origin='https://offline.invalid';
async function session() {
  const response=await routes.session.GET(new Request(origin+'/api/session')); assert.equal(response.status,200);
  const data=await response.json(); return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken,data};
}
function request(user,path,method,body,extra={}) {return new Request(origin+path,{method,headers:{origin,'sec-fetch-site':'same-origin',cookie:user.cookie,'x-csrf-token':user.csrf,...(body?{'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});}
async function submit(user,body) {const r=await routes.questions.POST(request(user,'/api/questions','POST',body));return {status:r.status,serverTiming:r.headers.get('Server-Timing'),data:await r.json()};}
async function history(user,headers={}) {const r=await routes.questions.GET(request(user,'/api/questions','GET',undefined,headers));return {status:r.status,data:await r.json()};}
const input=(question='How do I evaluate a stock?')=>({question,requestId:crypto.randomUUID()});
function budget(){return database.prepare('select * from generation_budget').get();}
try {
  await build({stdin:{contents:`export * as questions from './app/api/questions/route.ts'; export * as session from './app/api/session/route.ts'; export * as feedback from './app/api/feedback/route.ts'; export * as prompt from './lib/generation-prompt.ts'; export * as content from './lib/server/content.ts'; export * as generation from './lib/server/generation.ts';`,resolveDir:app,loader:'ts'},outfile:resolve(temp,'routes.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'offline-env',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'offline-env',namespace:'offline'}));b.onLoad({filter:/.*/,namespace:'offline'},()=>({contents:'export const env=globalThis.__LIVE_ENV;',loader:'js'}));}}]});
  routes=await import(pathToFileURL(resolve(temp,'routes.mjs')).href);
  await check('configured free-form response passes mechanical gates and exposes original excerpts',async()=>{
    const user=await session();assert.equal(user.data.generationEnabled,true);
    const body=input();const out=await submit(user,body);assert.equal(out.status,200);assert.equal(out.data.kind,'generated');assert.equal(fetchCount,3);
    assert.equal(out.data.generation.humanReviewed,false);assert.equal(out.data.generation.checks,'structure_citations_and_exact_quotes_only');
    const prepared=routes.prompt.buildGenerationPrompt(body.question,undefined,undefined,{queries:[body.question],usePreviousQuestion:false});for(const key of out.data.answer.reference_keys)assert.equal(out.data.references[key].excerpt,prepared.evidence.referencesForValidation[key].text);
    const replay=await submit(user,body);assert.deepEqual(replay.data,out.data);assert.equal(fetchCount,3);
    assert.equal(budget().attempts,3);assert.ok(budget().reserved_micro_cny>0);
    const job=database.prepare('select * from generation_jobs').get();assert.equal(job.input_tokens,1600);assert.equal(job.output_tokens,170);assert.equal(job.usage_reported,1);assert.equal(job.reserved_micro_cny,budget().reserved_micro_cny);
    assert.equal(writerFetchCount,1);assert.equal(reviewerFetchCount,1);
    assert.equal(out.data.elapsedMs,out.data.timings.totalMs);
    for(const stage of ['planning','retrieval','writer','reviewer']){assert.equal(out.data.timings[stage].status,'completed');assert.ok(out.data.timings[stage].durationMs>=0);}
    assert.match(out.serverTiming,/^request;dur=\d+$/);
    assert.deepEqual(requests[2].data.sources,requests[1].data.sources);assert.deepEqual(requests[2].data.draft,out.data.answer);
    assert.deepEqual((await history(user)).data.results,[out.data]);
  });
  await check('same-session cache is reused; other sessions and configured models remain independent',async()=>{
    const a=await session(),b=await session();const first=await submit(a,input());assert.equal(first.data.kind,'generated');
    const reused=await submit(a,input());assert.equal(reused.data.generation.cached,true);assert.equal(fetchCount,3);
    assert.notEqual(reused.data.id,first.data.id);assert.equal((await submit(b,input())).data.kind,'generated');assert.equal(fetchCount,6);
    values.MODEL_NAME='Qwen3.6-35B-A3B';const otherModel=await submit(a,input());assert.equal(otherModel.data.kind,'generated');assert.equal(otherModel.data.generation.cached,false);assert.equal(fetchCount,9);assert.equal(requests.at(-1).request.model,'Qwen3.6-35B-A3B');
    assert.equal((await submit(a,input())).data.generation.cached,true);assert.equal(fetchCount,9);
  });
  await check('concurrent duplicate UUID reserves and calls exactly once',async()=>{
    const user=await session(),body=input();mode='hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const pending=submit(user,body);await ready;
    const duplicate=await Promise.all([submit(user,body),submit(user,body),submit(user,body)]);
    duplicate.forEach(r=>assert.equal(r.status,202));assert.equal(fetchCount,2);assert.equal(budget().attempts,2);
    release();const first=await pending;assert.equal(first.data.kind,'generated');assert.deepEqual((await submit(user,body)).data,first.data);assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
    assert.equal(database.prepare('select count(*) as n from answers').get().n,1);
  });
  await check('different UUID pending cache recovers final answer through history without another call',async()=>{
    const user=await session();mode='hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,input());await ready;const duplicate=await submit(user,input());assert.equal(duplicate.status,202);
    release();await owner;const loaded=await history(user);assert.equal(loaded.data.results.length,2);loaded.data.results.forEach(r=>assert.equal(r.kind,'generated'));assert.equal(fetchCount,3);
    assert.doesNotMatch(JSON.stringify(loaded.data),/generationJobId|requestFingerprint|sessionId|csrfToken/);
  });
  await check('unresolved source key rejects draft while retaining billed attempt and usage',async()=>{
    const user=await session();mode='bad-reference';const out=await submit(user,input());assert.equal(out.data.kind,'unavailable');assert.equal(out.data.answer,undefined);
    assert.equal(out.data.timings.writer.status,'completed');assert.deepEqual(out.data.timings.reviewer,{status:'not_started',durationMs:null});
    assert.equal(budget().attempts,2);const row=database.prepare('select * from generation_jobs').get();assert.equal(row.input_tokens,1100);assert.equal(row.output_tokens,130);assert.equal(row.usage_reported,1);
    assert.doesNotMatch(row.response_json,/P99-999|mechanical test double/);
  });
  await check('uncited model refusal cannot bypass the citation gate with advice',async()=>{
    const user=await session();mode='refusal';const out=await submit(user,input());assert.equal(out.data.kind,'unavailable');assert.doesNotMatch(JSON.stringify(out.data),/Buy unsupported|double/);
  });
  await check('network failure keeps unknown usage and reservation without automatic retry',async()=>{
    const user=await session();mode='network';const body=input();const out=await submit(user,body);assert.equal(out.data.kind,'unavailable');assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_DETAIL/);
    assert.equal(out.data.timings.writer.status,'failed');assert.ok(out.data.timings.writer.durationMs>=0);assert.deepEqual(out.data.timings.reviewer,{status:'not_started',durationMs:null});
    const job=database.prepare('select * from generation_jobs').get();assert.equal(job.input_tokens,null);assert.equal(job.output_tokens,null);assert.equal(job.usage_reported,0);assert.equal(budget().attempts,2);
    await submit(user,body);await submit(user,input());assert.equal(fetchCount,2);assert.equal(budget().attempts,2);
  });
  await check('a negative source check withholds all draft and reviewer prose and retains both reservations',async()=>{
    const user=await session(),body=input();mode='review-reject';const out=await submit(user,body);
    assert.equal(out.data.kind,'unavailable');assert.equal(out.data.answer,undefined);
    assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_UNSUPPORTED_REVIEW_REASON|mechanical test double/);
    assert.equal(out.data.timings.writer.status,'completed');assert.equal(out.data.timings.reviewer.status,'completed');
    const row=database.prepare('select * from generation_jobs').get();assert.equal(row.failure_code,'grounding_rejected');
    assert.equal(row.input_tokens,1600);assert.equal(row.output_tokens,170);assert.equal(row.usage_reported,1);
    assert.equal(budget().attempts,3);assert.equal(row.reserved_micro_cny,budget().reserved_micro_cny);
    const diagnostic=JSON.parse(row.diagnostics_json),writerRequest=requests.find(r=>!r.isReview&&!r.isPlan),reviewRequest=requests.find(r=>r.isReview);
    assert.equal(diagnostic.schemaVersion,1);assert.equal(diagnostic.scope,'private_parsed_generation_diagnostics');assert.equal(diagnostic.retention.completeWithinScope,true);
    assert.deepEqual(diagnostic.planner,{inScope:true,queries:[body.question],usePreviousQuestion:false});
    const prepared=routes.prompt.buildGenerationPrompt(body.question,undefined,undefined,{queries:[body.question],usePreviousQuestion:false});
    assert.deepEqual(diagnostic.selection,{bundleHash:prepared.evidence.bundleHash,contextIds:prepared.evidence.contextIds});
    assert.deepEqual(diagnostic.draft,reviewRequest.data.draft);assert.deepEqual(diagnostic.groundingVerdict,{supported:false,issues:['PRIVATE_UNSUPPORTED_REVIEW_REASON'],issueCount:1});
    assert.deepEqual(diagnostic.stageUsage.planning,{attempted:true,usage:{inputTokens:100,outputTokens:10,totalTokens:110,reported:true}});
    assert.deepEqual(diagnostic.stageUsage.writer,{attempted:true,usage:{inputTokens:1000,outputTokens:120,totalTokens:1120,reported:true}});
    assert.deepEqual(diagnostic.stageUsage.reviewer,{attempted:true,usage:{inputTokens:500,outputTokens:40,totalTokens:540,reported:true}});
    assert.ok(Buffer.byteLength(row.diagnostics_json)<=32768);assert.doesNotMatch(row.diagnostics_json,/offline-mock-token|reasoning_content|source_contexts|context_text/);
    assert.ok(!row.diagnostics_json.includes(JSON.stringify(writerRequest.data.sources)));
    assert.doesNotMatch(row.response_json,/PRIVATE_UNSUPPORTED_REVIEW_REASON|private_parsed_generation_diagnostics|diagnosticsJson|diagnostics_json/);
    assert.doesNotMatch(JSON.stringify((await history(user)).data),/PRIVATE_UNSUPPORTED_REVIEW_REASON|private_parsed_generation_diagnostics|diagnosticsJson|diagnostics_json/);
    const sessionId=database.prepare('select id from sessions where csrf_token=?').get(user.csrf).id;
    assert.doesNotMatch(JSON.stringify(await routes.generation.storedGeneration(sessionId,row.id)),/PRIVATE_UNSUPPORTED_REVIEW_REASON|private_parsed_generation_diagnostics/);
    assert.doesNotMatch(JSON.stringify(await routes.generation.pollGeneration(sessionId,row.id,Date.now())),/PRIVATE_UNSUPPORTED_REVIEW_REASON|private_parsed_generation_diagnostics/);
    await submit(user,body);await submit(user,input());assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
    assert.equal(database.prepare('select diagnostics_json from generation_jobs').get().diagnostics_json,row.diagnostics_json);
  });
  await check('malformed or truncated reviewer output is never approval',async()=>{
    for(const [testMode,code] of [['review-invalid','grounding_validation'],['review-truncated','grounding_truncated']]){
      mode=testMode;const out=await submit(await session(),input());assert.equal(out.data.kind,'unavailable');assert.equal(out.data.answer,undefined);
      assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_BAD_VERDICT|mechanical test double/);
      const row=database.prepare('select * from generation_jobs order by created_at desc').get();assert.equal(row.failure_code,code);assert.equal(row.usage_reported,1);assert.equal(row.input_tokens,1600);
    }
    assert.equal(fetchCount,6);assert.equal(budget().attempts,6);
  });
  await check('review transport failure makes aggregate usage unknown and cannot trigger retry',async()=>{
    const user=await session(),body=input();mode='review-network';const out=await submit(user,body);assert.equal(out.data.kind,'unavailable');
    assert.equal(out.data.timings.writer.status,'completed');assert.equal(out.data.timings.reviewer.status,'failed');assert.ok(out.data.timings.reviewer.durationMs>=0);
    const row=database.prepare('select * from generation_jobs').get();assert.equal(row.failure_code,'grounding_network');assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,null);assert.equal(row.usage_reported,0);
    assert.equal(budget().attempts,3);assert.equal(row.reserved_micro_cny,budget().reserved_micro_cny);
    assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_REVIEW_NETWORK_DETAIL|mechanical test double/);
    await submit(user,body);assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
  });
  await check('missing usage from any completed stage leaves the aggregate unknown',async()=>{
    for(const testMode of ['plan-unknown','writer-unknown','review-unknown']){
      mode=testMode;const out=await submit(await session(),input());assert.equal(out.data.kind,'generated');
      const row=database.prepare('select * from generation_jobs order by created_at desc').get();assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,null);assert.equal(row.usage_reported,0);
    }
    assert.equal(fetchCount,9);assert.equal(budget().attempts,9);
  });
  await check('duplicates during review poll the existing job without a second reviewer',async()=>{
    const user=await session(),body=input();mode='review-hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,body);await ready;
    const duplicates=await Promise.all([submit(user,body),submit(user,body)]);duplicates.forEach(r=>assert.equal(r.status,202));
    assert.equal(writerFetchCount,1);assert.equal(reviewerFetchCount,1);assert.equal(budget().attempts,3);
    release();const result=await owner;assert.equal(result.data.kind,'generated');assert.deepEqual((await submit(user,body)).data,result.data);assert.equal(fetchCount,3);
  });
  await check('review reservation separately respects the shared monetary ceiling',async()=>{
    const user=await session();mode='hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,input());await ready;
    // Simulate other already-reserved jobs consuming the remaining shared allowance.
    database.prepare('update generation_budget set reserved_micro_cny=5000000').run();
    release();const out=await owner;assert.equal(out.data.kind,'unavailable');assert.equal(reviewerFetchCount,0);assert.equal(fetchCount,2);
    assert.equal(budget().reserved_micro_cny,5000000);assert.equal(budget().attempts,2);
    const row=database.prepare('select * from generation_jobs').get();assert.equal(row.failure_code,'grounding_budget');assert.equal(row.input_tokens,1100);assert.equal(row.usage_reported,1);
  });
  await check('daily allowance can block the third stage without publishing the writer draft',async()=>{
    values.MODEL_DAILY_REQUEST_LIMIT='2';const out=await submit(await session(),input());
    assert.equal(out.data.kind,'unavailable');assert.equal(out.data.answer,undefined);assert.equal(fetchCount,2);assert.equal(reviewerFetchCount,0);
    assert.equal(budget().attempts,2);assert.equal(budget().day_attempts,2);assert.equal(database.prepare('select failure_code from generation_jobs').get().failure_code,'grounding_budget');
  });
  await check('a pre-review cache identity cannot satisfy the new checked pipeline',async()=>{
    const user=await session(),body=input();const sessionId=database.prepare('select id from sessions where csrf_token=?').get(user.csrf).id;
    const prepared=routes.prompt.buildGenerationPrompt(body.question);
    const oldIdentity=JSON.stringify([sessionId,body.question.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '),null,null,null,prepared.evidence.bundleHash,routes.prompt.GENERATION_PROMPT_VERSION,values.MODEL_NAME]);
    const id=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(oldIdentity))).toString('hex');
    database.prepare('insert into generation_jobs(id,session_id,state,response_json,created_at,finished_at) values(?,?,?,?,?,?)').run(id,sessionId,'generated',JSON.stringify({kind:'generated',answer:{title:'OLD_UNCHECKED_CACHE',lead:'Old content',sections:[],reference_keys:[]}}),Date.now(),Date.now());
    const out=await submit(user,body);assert.equal(out.data.kind,'generated');assert.doesNotMatch(JSON.stringify(out.data),/OLD_UNCHECKED_CACHE/);assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
  });
  await check('global attempt cap is atomic across sessions and concurrent distinct requests',async()=>{
    values.MODEL_TOTAL_REQUEST_LIMIT='1';const a=await session(),b=await session();
    const out=await Promise.all([submit(a,input()),submit(b,input('How do I calculate owner earnings?'))]);assert.equal(fetchCount,1);assert.equal(budget().attempts,1);assert.deepEqual(out.map(r=>r.data.kind),['unavailable','unavailable']);assert.equal(reviewerFetchCount,0);
  });
  await check('daily reset permits a new day but never resets the lifetime request cap',async()=>{
    values.MODEL_TOTAL_REQUEST_LIMIT='6';values.MODEL_DAILY_REQUEST_LIMIT='3';
    assert.equal((await submit(await session(),input())).data.kind,'generated');
    assert.equal((await submit(await session(),input())).data.kind,'unavailable');assert.equal(fetchCount,3);
    database.prepare("update generation_budget set day='2000-01-01'").run();
    assert.equal((await submit(await session(),input())).data.kind,'generated');assert.equal(fetchCount,6);
    database.prepare("update generation_budget set day='2000-01-01'").run();
    assert.equal((await submit(await session(),input())).data.kind,'unavailable');assert.equal(fetchCount,6);assert.equal(budget().attempts,6);
  });
  await check('insufficient global estimated cost reserve prevents any network attempt',async()=>{
    values.MODEL_TOTAL_BUDGET_CNY='0.001';const out=await submit(await session(),input());assert.equal(out.data.kind,'unavailable');assert.equal(fetchCount,0);assert.equal(budget().attempts,0);assert.equal(budget().reserved_micro_cny,0);
  });
  await check('owned prior answer is conversation context and cross-session prior ID is denied',async()=>{
    const a=await session(),b=await session();const prior=await submit(a,input());
    const follow=await submit(a,{...input('Explain your second point'),previousAnswerId:prior.data.id});assert.equal(follow.data.kind,'generated');
    const data=requests.filter(r=>!r.isReview&&!r.isPlan).at(-1).data;assert.equal(data.previous_question_for_context_only,'How do I evaluate a stock?');assert.match(data.previous_answer_context_not_evidence,/Mechanical test answer/);assert.ok(data.previous_answer_context_not_evidence.length<=6000);
    assert.equal((await submit(b,{...input('Explain that point'),previousAnswerId:prior.data.id})).status,404);
  });
  await check('final answer-write failure recovers persisted job on reload without another call',async()=>{
    const user=await session();rejectFinalUpdate=true;const old=console.error;console.error=()=>{};let out;try{out=await submit(user,input());}finally{console.error=old;}
    assert.equal(out.status,503);assert.equal(fetchCount,3);const loaded=await history(user);assert.equal(loaded.data.results[0].kind,'generated');assert.equal(fetchCount,3);
  });
  await check('all seven curated answers remain exact and incur no model call',async()=>{
    const user=await session();const publicData=JSON.parse(await readFile(resolve(app,'lib/content/public-content.json'),'utf8'));
    for(const q of publicData.questions){const out=await submit(user,{...input(q.title),curatedSlug:q.slug});assert.equal(out.data.kind,'curated');assert.deepEqual(out.data.answer,routes.content.curatedAnswer(q).answer);assert.deepEqual(out.data.references,routes.content.curatedAnswer(q).references);}
    assert.equal(fetchCount,0);
  });
  await check('out-of-scope questions use only the planner and disabled configuration makes no new call',async()=>{
    const user=await session();assert.equal((await submit(user,input('Will it rain tomorrow?'))).data.kind,'unavailable');assert.equal(fetchCount,1);
    values.GENERATION_ENABLED='false';assert.equal((await session()).data.generationEnabled,false);assert.equal((await submit(user,input())).data.kind,'unavailable');assert.equal(fetchCount,1);
  });
  await check('history and feedback retain ownership and CSRF boundaries',async()=>{
    const a=await session(),b=await session();const out=await submit(a,input());assert.equal((await history(a,{'x-csrf-token':'bad'})).status,403);assert.equal((await history(a,{'sec-fetch-site':'cross-site'})).status,403);assert.deepEqual((await history(b)).data.results,[]);
    const denied=await routes.feedback.POST(request(b,'/api/feedback','POST',{answerId:out.data.id,helpful:false,reason:'sources',comment:'Offline automated test.'}));assert.equal(denied.status,404);
  });
  await check('JSON fence and 13 legitimate keys pass; fabricated source key and quotation fail',async()=>{
    const p=routes.prompt.buildGenerationPrompt('How do I evaluate a stock?');const keys=Object.keys(p.evidence.referencesForValidation).slice(0,13);
    const paragraph={text:'Mechanical parser fixture.',citations:keys};const raw=JSON.stringify({title:'Fixture',lead:paragraph,sections:[{heading:'Detail',paragraphs:[paragraph]}]});
    assert.equal(routes.prompt.parseGenerationResponse('```json\n'+raw+'\n```',p).answer.reference_keys.length,13);
    assert.throws(()=>routes.prompt.parseGenerationResponse(raw.replace(keys[0],'P99-999'),p));
    assert.throws(()=>routes.prompt.parseGenerationResponse(raw.replace('Mechanical parser fixture.','“A fabricated exact quotation from nowhere.”'),p));
  });
  await check('flat writer contract derives only explicit citations and rejects uncited or over-limit prose',async()=>{
    const p=routes.prompt.buildGenerationPrompt('How do I evaluate a stock?');const keys=Object.keys(p.evidence.referencesForValidation);
    const cited='A mechanically checked paragraph. [['+keys[0]+']]';const value={title:'Flat fixture',lead:cited,sections:[['Detail',cited]]};
    assert.deepEqual(routes.prompt.parseGenerationResponse(JSON.stringify(value),p).answer.reference_keys,[keys[0]]);
    assert.throws(()=>routes.prompt.parseGenerationResponse(JSON.stringify({...value,lead:'An uncited substantive claim.'}),p));
    assert.throws(()=>routes.prompt.parseGenerationResponse(JSON.stringify({...value,sections:[['Detail','An uncited paragraph.\n\n'+cited]]}),p));
    assert.throws(()=>routes.prompt.parseGenerationResponse(JSON.stringify({...value,lead:'A bad key. [[P99-999]]'}),p));
    assert.ok(keys.length>=33);
    assert.throws(()=>routes.prompt.parseGenerationResponse(JSON.stringify({...value,lead:'Too many keys. '+keys.slice(0,33).map(key=>'[['+key+']]').join('')}),p));
    assert.throws(()=>routes.prompt.parseGenerationResponse(JSON.stringify({...value,sections:[['Detail',cited,'An extra string']]}),p));
  });
  await check('session erasure cannot replenish permanent global budget',async()=>{
    const user=await session();await submit(user,input());const before={...budget()};database.prepare('delete from sessions').run();assert.deepEqual({...budget()},before);assert.equal(database.prepare('select count(*) as n from generation_jobs').get().n,0);
  });
  await check('pending request remains pinned when its previous record version changes',async()=>{
    const user=await session();const data=JSON.parse(await readFile(resolve(app,'lib/content/public-content.json'),'utf8'));const q=data.questions[0];
    const prior=await submit(user,{...input(q.title),curatedSlug:q.slug});
    const follow={...input('Explain your second point'),previousAnswerId:prior.data.id};mode='hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,follow);await ready;
    database.prepare('update answers set content_version=? where id=?').run('changed-prior-version',prior.data.id);
    const duplicate=await submit(user,follow);assert.equal(duplicate.status,202);assert.equal(fetchCount,2);assert.equal(budget().attempts,2);
    release();assert.equal((await owner).data.kind,'generated');assert.equal(fetchCount,3);
  });
  await check('missing pinned job has a bounded lease and never dispatches a replacement call',async()=>{
    const user=await session(),body=input();const sessionId=database.prepare('select id from sessions where csrf_token=?').get(user.csrf).id;
    const hex=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
    const id='rq_'+await hex(sessionId+':'+body.requestId);const fingerprint=await hex(JSON.stringify([body.question,null,null]));
    const result={id,question:body.question,kind:'processing',message:'An answer is being prepared from the selected sources.',retryAfterMs:2000,elapsedMs:0};
    database.prepare('insert into answers(id,session_id,question,kind,content_version,response_json,elapsed_ms,created_at) values(?,?,?,?,?,?,?,?)').run(id,sessionId,body.question,'processing','test',JSON.stringify({storageVersion:2,requestFingerprint:fingerprint,generationJobId:'missing-job',result}),0,Date.now());
    assert.equal((await submit(user,body)).status,202);assert.equal(fetchCount,0);
    database.prepare('update answers set created_at=? where id=?').run(Date.now()-routes.generation.GENERATION_LEASE_MS-1,id);
    const ended=await submit(user,body);assert.equal(ended.status,200);assert.equal(ended.data.kind,'unavailable');assert.equal(fetchCount,0);
    assert.equal(ended.data.timings.totalMs,null);for(const stage of ['planning','retrieval','writer','reviewer'])assert.deepEqual(ended.data.timings[stage],{status:'unknown',durationMs:null});
  });
  await check('lead-only current-object answer still runs all source checks and review',async()=>{
    const user=await session();mode='lead-only';const out=await submit(user,input());
    assert.equal(out.data.kind,'generated');assert.equal(out.data.answer.sections.length,0);assert.ok(out.data.answer.lead.includes('[['));
    assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
  });
  await check('cached answer keeps measured original timings instead of fast cache-serving duration',async()=>{
    const user=await session();mode='timed';const first=await submit(user,input());
    assert.equal(first.data.kind,'generated');assert.ok(first.data.timings.writer.durationMs>=5);assert.ok(first.data.timings.reviewer.durationMs>=5);
    const cached=await submit(user,input());assert.equal(cached.data.generation.cached,true);
    assert.deepEqual(cached.data.timings,first.data.timings);assert.equal(cached.data.elapsedMs,first.data.elapsedMs);assert.equal(fetchCount,3);
    const job=database.prepare('select response_json from generation_jobs').get();assert.deepEqual(JSON.parse(job.response_json).timings,first.data.timings);
    const loaded=await history(user);for(const result of loaded.data.results)assert.deepEqual(result.timings,first.data.timings);
  });
  await check('poll and history recovery preserve original measurements rather than final poll or row age',async()=>{
    const user=await session();mode='hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,input());await ready;
    const pollBody=input(),historyBody=input();const pollPending=await submit(user,pollBody),historyPending=await submit(user,historyBody);
    assert.equal(pollPending.status,202);assert.equal(historyPending.status,202);
    await new Promise(resolve=>setTimeout(resolve,12));release();const original=await owner;
    database.prepare('update answers set created_at=? where id in (?,?)').run(Date.now()-60000,pollPending.data.id,historyPending.data.id);
    const polled=await submit(user,pollBody);assert.equal(polled.data.kind,'generated');assert.deepEqual(polled.data.timings,original.data.timings);assert.equal(polled.data.elapsedMs,original.data.elapsedMs);
    const loaded=await history(user);for(const result of loaded.data.results){assert.deepEqual(result.timings,original.data.timings);assert.equal(result.elapsedMs,original.data.elapsedMs);}
    assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
  });
  await check('malformed or truncated plans cannot reach retrieval or writer and are not retried',async()=>{
    for(const testMode of ['plan-invalid','plan-truncated']){
      const user=await session(),body=input();mode=testMode;const out=await submit(user,body);
      assert.equal(out.data.kind,'unavailable');assert.equal(out.data.answer,undefined);assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_PLANNER|invented instruction/);
      assert.deepEqual(out.data.timings.retrieval,{status:'not_started',durationMs:null});assert.deepEqual(out.data.timings.writer,{status:'not_started',durationMs:null});
      const row=database.prepare('select * from generation_jobs order by created_at desc').get();assert.equal(row.failure_code,testMode==='plan-invalid'?'planning_validation':'planning_truncated');assert.equal(row.input_tokens,100);
      await submit(user,body);await submit(user,input());
    }
    assert.equal(plannerFetchCount,2);assert.equal(fetchCount,2);assert.equal(budget().attempts,2);assert.equal(writerFetchCount,0);assert.equal(reviewerFetchCount,0);
  });
  await check('planner network failure keeps unknown usage and permanent reservation without retry',async()=>{
    const user=await session(),body=input();mode='plan-network';const out=await submit(user,body);
    assert.equal(out.data.kind,'unavailable');assert.equal(out.data.timings.planning.status,'failed');assert.equal(out.data.timings.retrieval.status,'not_started');assert.doesNotMatch(JSON.stringify(out.data),/PRIVATE_PLANNER/);
    const row=database.prepare('select * from generation_jobs').get();assert.equal(row.failure_code,'planning_network');assert.equal(row.usage_reported,0);assert.equal(row.input_tokens,null);
    const diagnostic=JSON.parse(row.diagnostics_json);assert.equal(diagnostic.planner,null);assert.equal(diagnostic.selection,null);assert.equal(diagnostic.draft,null);assert.equal(diagnostic.groundingVerdict,null);
    assert.deepEqual(diagnostic.stageUsage.planning,{attempted:true,usage:{inputTokens:null,outputTokens:null,totalTokens:null,reported:false}});
    assert.deepEqual(diagnostic.stageUsage.writer,{attempted:false,usage:null});assert.deepEqual(diagnostic.stageUsage.reviewer,{attempted:false,usage:null});assert.doesNotMatch(row.diagnostics_json,/PRIVATE_PLANNER|offline-mock-token/);
    await submit(user,body);await submit(user,input());assert.equal(fetchCount,1);assert.equal(budget().attempts,1);assert.equal(writerFetchCount,0);
  });
  await check('concurrent duplicate while planner is pending shares one paid planner',async()=>{
    const user=await session(),body=input();mode='plan-hold';let notice;const ready=new Promise(r=>notice=r);entered=notice;
    const owner=submit(user,body);await ready;const duplicates=await Promise.all([submit(user,body),submit(user,body)]);
    duplicates.forEach(r=>assert.equal(r.status,202));assert.equal(fetchCount,1);assert.equal(budget().attempts,1);assert.equal(writerFetchCount,0);
    release();assert.equal((await owner).data.kind,'generated');assert.equal(fetchCount,3);assert.equal(plannerFetchCount,1);assert.equal(budget().attempts,3);
  });
  await check('completed plan cannot dispatch writer after the final shared attempt is used',async()=>{
    values.MODEL_TOTAL_REQUEST_LIMIT='1';const user=await session(),body=input();const out=await submit(user,body);
    assert.equal(out.data.kind,'unavailable');assert.equal(out.data.timings.planning.status,'completed');assert.equal(out.data.timings.writer.status,'not_started');
    const row=database.prepare('select * from generation_jobs').get();assert.equal(row.failure_code,'global_budget');assert.equal(row.input_tokens,100);assert.equal(row.output_tokens,10);
    await submit(user,body);assert.equal(fetchCount,1);assert.equal(plannerFetchCount,1);assert.equal(writerFetchCount,0);assert.equal(budget().attempts,1);
  });
  await check('trial configuration cannot raise hard lifetime or cost ceilings',async()=>{
    assert.throws(()=>routes.generation.liveConfigFrom({...values,MODEL_TOTAL_REQUEST_LIMIT:'21'}));assert.throws(()=>routes.generation.liveConfigFrom({...values,MODEL_TOTAL_BUDGET_CNY:'5.01'}));assert.throws(()=>routes.generation.liveConfigFrom({...values,MODEL_NAME:'unverified-model'}));
  });
  await check('diagnostic migration is additive and preserves historical responses and permanent budget',async()=>{
    const prior=new DatabaseSync(':memory:');try{
      prior.exec(migrations[0]);prior.exec(migrations[1]);
      prior.prepare('insert into sessions(id,csrf_token,created_at,expires_at) values(?,?,?,?)').run('prior-session','prior-csrf',1,9999);
      prior.prepare('insert into generation_jobs(id,session_id,state,response_json,reserved_micro_cny,input_tokens,output_tokens,usage_reported,failure_code,created_at,finished_at) values(?,?,?,?,?,?,?,?,?,?,?)').run('prior-job','prior-session','unavailable','{"kind":"unavailable","message":"Original outcome"}',650019,31163,1163,1,'grounding_rejected',1,2);
      prior.prepare('insert into generation_budget(id,attempts,reserved_micro_cny,day,day_attempts) values(?,?,?,?,?)').run('private-source-grounded-trial',9,650019,'2026-11-12',3);
      const job=prior.prepare('select * from generation_jobs').get(),ledger=prior.prepare('select * from generation_budget').get();
      assert.match(migrations[2],/^ALTER TABLE `generation_jobs` ADD `diagnostics_json` text;\s*$/);prior.exec(migrations[2]);
      const {diagnostics_json,...after}=prior.prepare('select * from generation_jobs').get();assert.equal(diagnostics_json,null);assert.deepEqual({...job},after);assert.deepEqual(prior.prepare('select * from generation_budget').get(),ledger);
    }finally{prior.close();}
    assert.equal(fetchCount,0);
  });
  await check('private diagnostics omit overflow explicitly and retain verdict polarity and unknown usage',async()=>{
    const fixture={model:'fixture',failureCode:'grounding_rejected',planner:{inScope:true,queries:['fixture'],usePreviousQuestion:false},selection:{bundleHash:'fixture-hash',contextIds:['fixture-context']},draft:{title:'Fixture',lead:'界'.repeat(16000),sections:[],reference_keys:['P01-001']},groundingVerdict:{supported:false,issues:Array.from({length:12},()=> '界'.repeat(1000))},stageUsage:{planning:{attempted:true,usage:null},writer:{attempted:true,usage:null},reviewer:{attempted:true,usage:null}}};
    const text=routes.generation.serializeGenerationDiagnostics(fixture,'not-present'),saved=JSON.parse(text);
    assert.ok(Buffer.byteLength(text)<=32768);assert.equal(saved.retention.completeWithinScope,false);assert.equal(saved.draft,null);assert.equal(saved.groundingVerdict.supported,false);assert.equal(saved.groundingVerdict.issueCount,12);assert.equal(saved.groundingVerdict.issues,null);
    assert.deepEqual(saved.retention.omittedFields.map(item=>item.field),['draft','groundingVerdict.issues']);assert.ok(saved.retention.omittedFields.every(item=>item.reason==='storage_byte_limit'&&item.originalUtf8Bytes>0));
    assert.deepEqual(saved.stageUsage.writer,{attempted:true,usage:{inputTokens:null,outputTokens:null,totalTokens:null,reported:false}});assert.equal(fetchCount,0);
  });
  await check('diagnostics redact the configured provider credential and never copy unlisted raw fields',async()=>{
    const secret='offline-diagnostic-secret';const fixture={model:'fixture',failureCode:null,planner:{inScope:true,queries:[secret],usePreviousQuestion:false},selection:{bundleHash:'fixture-hash',contextIds:['fixture-context']},draft:{title:'Fixture',lead:secret,sections:[],reference_keys:['P01-001'],reasoning_content:'PRIVATE_RAW_REASONING'},groundingVerdict:{supported:false,issues:[secret]},stageUsage:{planning:{attempted:true,usage:null},writer:{attempted:true,usage:null},reviewer:{attempted:true,usage:null}},rawOutput:'PRIVATE_RAW_OUTPUT',provider:{apiKey:secret}};
    const text=routes.generation.serializeGenerationDiagnostics(fixture,secret),saved=JSON.parse(text);
    assert.ok(!text.includes(secret));assert.doesNotMatch(text,/PRIVATE_RAW|reasoning_content|apiKey|rawOutput/);assert.equal(saved.retention.completeWithinScope,false);
    assert.deepEqual(saved.retention.redactedFields,['planner.queries[0]','draft.lead','groundingVerdict.issues[0]']);assert.equal(fetchCount,0);
  });
  await check('cached historical jobs without diagnostics are not regenerated or retroactively filled',async()=>{
    const user=await session(),body=input();const first=await submit(user,body);assert.equal(first.data.kind,'generated');assert.equal(fetchCount,3);
    database.prepare('update generation_jobs set diagnostics_json=null').run();const snapshot=database.prepare('select response_json from generation_jobs').get().response_json;
    const cached=await submit(user,input());assert.equal(cached.data.generation.cached,true);assert.equal(fetchCount,3);assert.equal(budget().attempts,3);
    const row=database.prepare('select response_json,diagnostics_json from generation_jobs').get();assert.equal(row.diagnostics_json,null);assert.equal(row.response_json,snapshot);
  });
} finally {
  globalThis.fetch=originalFetch;
  report.passed=report.checks.length===40&&report.checks.every(c=>c.passed);
  await writeReport('offline-backend-report.json', report);
  await rm(temp,{recursive:true,force:true});database?.close();
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,networkCalls:0}));
}
