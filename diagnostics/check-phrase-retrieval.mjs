import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeReport} from './report-output.mjs';

globalThis.fetch=()=>{throw Error('No network allowed.');};
const built=await build({stdin:{contents:"export * from './lib/retrieved-evidence.ts'; export {QUERY_PLAN_VERSION} from './lib/query-plan.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const captured=JSON.parse(await readFile(new URL('./fixtures/captured-q01-minimax-plan.json',import.meta.url),'utf8'));
const packetBytes=await readFile('lib/content/live-evidence-packets.json'),packet=JSON.parse(packetBytes);
const hashes=JSON.parse(await readFile(new URL('./fixtures/source-hashes.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(packetBytes),hashes.packetSha256);
assert.equal(hash(await readFile('lib/content/live-retrieval-index.json')),hashes.indexSha256);
const normalize=text=>text.replace(/\s+/g,' ').trim();
const required=[['letter-1986-0285-0297',['berkshire-letter-1986:u0286','berkshire-letter-1986:u0287','berkshire-letter-1986:u0288','berkshire-letter-1986:u0290','berkshire-letter-1986:u0291','berkshire-letter-1986:u0292','berkshire-letter-1986:u0293']],['letter-1986-0209-0210',['berkshire-letter-1986:u0209','berkshire-letter-1986:u0210']]].flatMap(([id,ids])=>{
  const c=packet.contexts.find(c=>c.context_id===id);assert.ok(c);
  return ids.map(id=>{const p=c.paragraphs.find(p=>p.id===id);assert.ok(p);return {id,sourceId:c.source_id,text:normalize(p.reading_text??p.text)};});
});
function inspect(label,question,plan){
  const started=performance.now(),result=api.searchArchive(question,undefined,plan),elapsedMs=performance.now()-started;
  const passages=required.map(p=>({id:p.id,contexts:result.contexts.filter(c=>c.source_id===p.sourceId&&normalize(c.paragraphs.map(p=>p.text).join('\n')).includes(p.text)).map(c=>c.context_id)}));
  const ids=new Set(result.contexts.map(c=>c.context_id));
  const companionPreserved=result.contexts.every(c=>(c.required_companion_context_ids??[]).every(id=>ids.has(id)));
  return {label,question,plan,contextIds:[...ids],sourceCharacters:result.sourceCharacters,elapsedMs,passages,fullDefinitionAndQualifications:passages.every(p=>p.contexts.length),companionPreserved,withinBounds:result.contexts.length<=6&&result.sourceCharacters<=42000};
}
const actual=inspect('actual captured MiniMax plan',captured.question,captured.plan);
const paraphrase=query=>({...captured.plan,queries:captured.plan.queries.map(q=>q.includes('owner earnings')?query:q)});
const synthetic=[
  inspect('synthetic component paraphrase','How should I estimate what a whole company is worth?',paraphrase('calculating owner earnings Buffett')),
  inspect('synthetic component paraphrase','How can I estimate the value of shares from business cash?',paraphrase('owner earnings calculation')),
  inspect('fresh direct question','How do I calculate owner earnings?'),
  inspect('fresh direct question','What does Berkshire Hathaway mean by owner earnings?'),
];
const negatives=[
  inspect('narrow negative','How does Buffett choose the discount rate?'),
  inspect('narrow negative','What distinguishes book value from intrinsic value?'),
  inspect('unrelated negative','How do I bake sourdough bread?'),
];
// Retain an observed counterexample. A phrase rerank does not guarantee that a
// foundational definition wins over a related discussion of a formula.
const knownLimitation=inspect('observed unresolved paraphrase','How should I estimate the cash a business can produce for its owners?',paraphrase('owner earnings formula Berkshire Hathaway'));
const reordered=inspect('query-order invariance',captured.question,{...captured.plan,queries:[...captured.plan.queries].reverse()});
const expected=[actual,...synthetic];
const checks={targetContainsCompleteDefinition:actual.fullDefinitionAndQualifications,syntheticAndDirectCases:synthetic.every(c=>c.fullDefinitionAndQualifications),boundedCompleteContexts:[...expected,...negatives,knownLimitation].every(c=>c.withinBounds&&c.companionPreserved),noOwnerDefinitionInjectedForNegatives:negatives.every(c=>!c.passages[0].contexts.length),unrelatedEmpty:negatives.at(-1).contextIds.length===0,queryOrderInvariant:JSON.stringify(actual.contextIds)===JSON.stringify(reordered.contextIds)};
const passed=Object.values(checks).every(Boolean);
const report={version:'original-phrase-retrieval-1',modelCalls:0,retrievalVersion:api.RETRIEVAL_VERSION,plannerVersion:api.QUERY_PLAN_VERSION,scope:'Saved actual plan replay plus synthetic/direct lexical regressions; not an answer-quality or general semantic retrieval guarantee.',packetSha256:hash(packetBytes),capturedResultSha256:captured.capturedResultSha256,before:{contextIds:captured.contextIds,ownerQueryBaseline:captured.ownerQueryBaseline},actual,synthetic,negatives,knownLimitations:[knownLimitation],allProbedMethodQuestionsResolved:[...expected,knownLimitation].every(c=>c.fullDefinitionAndQualifications),checks,passed};
console.log(JSON.stringify({report:await writeReport('phrase-retrieval-regression.json',report),passed,checks,knownLimitationResolved:knownLimitation.fullDefinitionAndQualifications,actualElapsedMs:actual.elapsedMs}));
assert.ok(passed,'Target regression or a bounded negative check failed; inspect report.');
