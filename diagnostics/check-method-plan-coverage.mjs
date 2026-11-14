import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {writeReport} from './report-output.mjs';

// These are fixed, editorially constructed plans, NOT new planner outputs.
// This test establishes retrieval capability and preserves the captured miss.
// Real planner output still requires a separately recorded model smoke test.
globalThis.fetch=()=>{throw Error('No network allowed.');};
const compiled=await build({stdin:{contents:"export * from './lib/query-plan.ts'; export * from './lib/retrieved-evidence.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const fixture=JSON.parse(await readFile(new URL('./fixtures/captured-q01-plan.json',import.meta.url),'utf8'));
const packetBytes=await readFile('lib/content/live-evidence-packets.json');
const packet=JSON.parse(packetBytes);
const hashes=JSON.parse(await readFile(new URL('./fixtures/source-hashes.json',import.meta.url),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(sha(packetBytes),hashes.packetSha256,'Original evidence packet must remain immutable.');
const normalize=text=>text.replace(/\s+/g,' ').trim();
function original(contextId,ids) {
  const context=packet.contexts.find(c=>c.context_id===contextId);assert.ok(context);
  return ids.map(id=>{const p=context.paragraphs.find(p=>p.id===id);assert.ok(p);return {id,sourceId:context.source_id,text:normalize(p.reading_text??p.text)};});
}
const essential=[
  ...original('letter-1986-0285-0297',['berkshire-letter-1986:u0286','berkshire-letter-1986:u0287','berkshire-letter-1986:u0288','berkshire-letter-1986:u0290','berkshire-letter-1986:u0291','berkshire-letter-1986:u0292','berkshire-letter-1986:u0293']),
  ...original('letter-1986-0209-0210',['berkshire-letter-1986:u0209','berkshire-letter-1986:u0210']),
  ...original('letter-1992-0074-0085',['berkshire-letter-1992:u0080','berkshire-letter-1992:u0081']),
];
function inspect(question,plan) {
  const parsed=api.parseQueryPlanResponse(JSON.stringify(plan));
  const selected=api.searchArchive(question,undefined,parsed);
  const matches=essential.map(p=>({paragraphId:p.id,contextIds:selected.contexts.filter(c=>c.source_id===p.sourceId&&normalize(c.paragraphs.map(p=>p.text).join('\n')).includes(p.text)).map(c=>c.context_id)}));
  const ids=new Set(selected.contexts.map(c=>c.context_id));
  const companionPreserved=selected.contexts.every(c=>(c.required_companion_context_ids??[]).every(id=>ids.has(id)));
  return {question,plan,contextIds:[...ids],sourceCharacters:selected.sourceCharacters,withinBounds:selected.contexts.length<=6&&selected.sourceCharacters<=42000,companionPreserved,matches,essentialPassagesPresent:matches.every(p=>p.contextIds.length)};
}
const baseline=inspect(fixture.question,fixture.plan);
// Keep the old result as historical evidence; intentional ranking changes may
// produce different current contexts for the exact same frozen plan.
assert.ok(!fixture.originalSelection.contextIds.includes('letter-1986-0285-0297'));
const componentPlan={...fixture.plan,queries:[...fixture.plan.queries,'owner earnings depreciation capital expenditures working capital']};
const positive=[fixture.question,'How should I work out what a whole business is worth?','What is the method for valuing shares from the cash their business generates?'].map(q=>inspect(q,componentPlan));
const negative=[
  {question:'How does Buffett choose the discount rate?',queries:['discount rate interest rates valuation']},
  {question:'What distinguishes book value from intrinsic value?',queries:['book value intrinsic value accounting difference']},
  {question:'How do I bake sourdough bread?',queries:[],inScope:false},
].map(({question,queries,inScope=true})=>inspect(question,{inScope,queries,usePreviousQuestion:false}));
// There is no deterministic broad-method or finance-source injection: narrow
// and irrelevant queries do not acquire the owner-earnings prerequisite plan.
const negativesPass=negative.every(c=>!c.matches.find(p=>p.paragraphId==='berkshire-letter-1986:u0286').contextIds.length);
const passed=positive.every(c=>c.essentialPassagesPresent&&c.withinBounds&&c.companionPreserved)&&negativesPass;
const report={version:'method-plan-coverage-2',queryPlanVersion:api.QUERY_PLAN_VERSION,retrievalVersion:api.RETRIEVAL_VERSION,modelCalls:0,scope:'Captured pre-change planner miss plus synthetic component-plan retrieval capability. Not evidence that the revised planner generates these queries or that answer quality passes.',packetSha256:sha(packetBytes),capturedResultSha256:fixture.capturedResultSha256,historicalSelection:fixture.originalSelection,currentFrozenPlanReplay:baseline,syntheticComponentCases:positive,narrowAndUnrelatedCases:negative,passed};
console.log(JSON.stringify({report:await writeReport('method-plan-coverage.json',report),passed,positive:positive.map(c=>({question:c.question,complete:c.essentialPassagesPresent,characters:c.sourceCharacters})),negativesPass}));
assert.ok(passed,'Synthetic component-plan coverage or negative boundary failed; inspect report.');
