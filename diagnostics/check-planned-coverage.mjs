/** Offline saved-plan coverage and source-selection constraints; not answer acceptance. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'test-results/archive');
await mkdir(out,{recursive:true});globalThis.fetch=()=>{throw Error('Network forbidden.');};
const fixture=JSON.parse(await readFile(resolve(root,'diagnostics/fixtures/planned-coverage.json'),'utf8'));
async function compile(name,plugins=[]){const path=resolve(out,name+'.mjs');await build({stdin:{contents:"export * from './lib/retrieved-evidence.ts';",resolveDir:root,loader:'ts'},outfile:path,bundle:true,platform:'node',format:'esm',plugins});return import(pathToFileURL(path).href);}
const api=await compile('coverage-search'),ids=s=>s.contexts.map(c=>c.context_id),plan={queries:fixture.baseline.queries,usePreviousQuestion:false},question=fixture.baseline.question;
const actual=api.searchArchive(question,undefined,plan),evidence=api.buildRetrievedEvidence(question,undefined,plan);
assert.equal(evidence.bundleHash,fixture.bundleHash);assert.equal(api.LIVE_EVIDENCE_VERSION,`${evidence.bundleHash}:${api.RETRIEVAL_VERSION}`);assert.notEqual(api.LIVE_EVIDENCE_VERSION,evidence.bundleHash);assert.deepEqual(evidence.contextIds,ids(actual));
for(const best of fixture.baseline.perQueryBest)assert.ok(ids(actual).includes(best.id),best.query);
assert.ok(fixture.baseline.perQueryBest.some(best=>!fixture.baseline.selectedIds.includes(best.id)));
for(const queries of [[...plan.queries].reverse(),plan.queries.map(q=>q.split(' ').reverse().join(' '))])assert.deepEqual(ids(api.searchArchive(question,undefined,{...plan,queries})),ids(actual));
const pair=plan.queries.slice(0,2),duplicates=[...pair,pair[0].toUpperCase(),pair[1].split(' ').reverse().join(' ')];
assert.deepEqual(ids(api.searchArchive(question,undefined,{...plan,queries:duplicates})),ids(api.searchArchive(question,undefined,{...plan,queries:pair})));
for(const test of fixture.unplanned){assert.deepEqual(ids(api.searchArchive(test.question,test.previousQuestion)),test.ids,test.id);assert.deepEqual(ids(api.searchArchive(test.question,test.previousQuestion,{queries:[],usePreviousQuestion:api.usesPreviousQuestion(test.question,test.previousQuestion)})),test.ids,test.id+' empty plan');}
function bounds(s){assert.ok(s.contexts.length<=6);assert.ok(s.sourceCharacters<=42000);assert.equal(new Set(ids(s)).size,s.contexts.length);for(const c of s.contexts)for(const id of c.required_companion_context_ids??[])assert.ok(ids(s).includes(id));}
bounds(actual);
// Production selection with synthetic postings. Source text sizes independently
// stress budgets while equal indexed lengths keep fixture ranking deterministic.
const defs=[
 {id:'alpha-too-large',term:'alpha',tf:100,chars:43000},{id:'alpha-small',term:'alpha',tf:1,unit:'shared'},
 {id:'beta-parent',term:'beta',tf:100,source:'paired',companions:['beta-companion']},{id:'beta-companion',source:'paired'},
 {id:'delta-blocked',term:'delta',tf:100,source:'paired'},{id:'delta-next',term:'delta',tf:1},
 {id:'gamma-overlap',term:'gamma',tf:100,unit:'shared'},{id:'gamma-next',term:'gamma',tf:1},
 {id:'epsilon-parent',term:'epsilon',tf:100,companions:['epsilon-1','epsilon-2','epsilon-3','epsilon-4','epsilon-5']},
 ...Array.from({length:5},(_,i)=>({id:`epsilon-${i+1}`})),{id:'epsilon-next',term:'epsilon',tf:1},
 {id:'incomplete',term:'zeta',tf:100,complete:false},{id:'zeta-next',term:'zeta',tf:1}
];
const postings={},contexts={};const documents=defs.map((d,at)=>{if(d.term)(postings[d.term]??=[]).push(at,d.tf);contexts[d.id]={context_id:d.id,source_id:d.source??d.id,title:d.id,source_url:'https://example.invalid/'+d.id,date:null,date_kind:'unresolved',boundary:'synthetic',paragraphs:[{id:d.id+'-p1',speaker:null,text:'x'.repeat(d.chars??1000)}],required_companion_context_ids:d.companions??[]};return {id:d.id,sourceId:d.source??d.id,title:d.id,length:100,textCharacters:d.chars??1000,unitIds:[d.unit??d.id],complete:d.complete??true,kind:'synthetic',shard:'synthetic'};});
const mockIndex={version:'synthetic',bundle_hash:'synthetic',scope:'test only',summary:{},documents,postings};
const plugin={name:'synthetic-archive',setup(b){b.onResolve({filter:/content\/archive-index\.json$/},()=>({path:'index',namespace:'synthetic'}));b.onResolve({filter:/content\/archive-shards$/},()=>({path:'shards',namespace:'synthetic'}));b.onLoad({filter:/.*/,namespace:'synthetic'},a=>({loader:'js',contents:a.path==='index'?`export default ${JSON.stringify(mockIndex)}`:`export const archiveShards={synthetic:()=>(${JSON.stringify(contexts)})}`}));}};
const mock=await compile('coverage-synthetic',[plugin]);
for(const [queries,expected] of [[['alpha','beta','gamma','delta'],['alpha-small','beta-parent','beta-companion','delta-next','gamma-next']],[['alpha','epsilon'],['alpha-small','epsilon-next']],[['zeta'],['zeta-next']]]){const s=mock.searchArchive('unknown',undefined,{queries,usePreviousQuestion:false});assert.deepEqual(ids(s),expected);bounds(s);}
const report={scope:'Offline saved actual plan: query coverage, order/deduplication, raw ranking invariance, cache identity and synthetic complete/overlap/companion/source/character/context limits. No live planner or answer-quality acceptance.',passed:true,networkCalls:0,modelCalls:0,unplannedCases:fixture.unplanned.length,version:api.LIVE_EVIDENCE_VERSION,bundleHash:evidence.bundleHash,sourceCharacters:actual.sourceCharacters,selectedContexts:actual.contexts.map(c=>({id:c.context_id,title:c.title})),residualLimit:'Best intrinsic-value-calculation lexical hit concerns Berkshire marketable securities; query representation does not establish a general calculation explanation.'};await writeFile(resolve(out,'planned-coverage-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
