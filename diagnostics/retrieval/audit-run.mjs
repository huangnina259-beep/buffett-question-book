import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Run from any working directory. Requires the repository's installed dependencies.
const here=dirname(fileURLToPath(import.meta.url)),app=resolve(here,'../..');
const outputDirectory=resolve(app,'test-results/retrieval');
const require=createRequire(resolve(app,'package.json'));
const fixture=JSON.parse(await readFile(resolve(here,'audit-fixtures.json'),'utf8'));
const paths=['lib/retrieved-evidence.ts','lib/content/live-retrieval-index.json','lib/content/live-evidence-packets.json'];
const sourceBytes=await Promise.all(paths.map(p=>readFile(resolve(app,p))));
const sha=v=>createHash('sha256').update(v).digest('hex');
const index=JSON.parse(sourceBytes[1]),packet=JSON.parse(sourceBytes[2]);
const compiled=await require('esbuild').build({entryPoints:[resolve(app,paths[0])],bundle:true,platform:'node',format:'esm',write:false});
const actual=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const match=(q,t)=>(` ${normalize(q)} `).includes(` ${normalize(t)} `);
const contextById=new Map(packet.contexts.map(c=>[c.context_id,c]));
const trace=(q,p='')=>{
 const direct=index.topics.some(t=>t.terms.some(s=>match(q,s)));
 const broadDirect=index.broad_evaluation.terms.filter(t=>match(q,t));
 const broadPrior=!direct?index.broad_evaluation.terms.filter(t=>match(p??'',t)):[];
 const ranked=index.topics.map((t,order)=>({t,order,current:t.terms.filter(s=>match(q,s)),prior:t.terms.filter(s=>!match(q,s)&&match(p??'',s))})).map(x=>({...x,score:x.current.length*2+x.prior.length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||(b.t.priority??0)-(a.t.priority??0)||a.order-b.order);
 const selected=new Set(),groups=[];let chars=0;
 const append=(name,ids)=>{const add=[...new Set(ids)].filter(id=>!selected.has(id));const size=add.reduce((s,id)=>s+contextById.get(id).paragraphs.reduce((z,p)=>z+(p.reading_text??p.text).length,0),0);const fits=selected.size+add.length<=Math.min(8,index.max_contexts)&&chars+size<=Math.min(60000,index.max_source_characters);groups.push({name,additional_contexts:add,additional_characters:size,selected:fits,reason:fits?'fits':'entire_group_skipped_by_count_or_character_limit'});if(fits){add.forEach(id=>selected.add(id));chars+=size;}};
 if(broadDirect.length||broadPrior.length)append('broad_evaluation',index.broad_evaluation.context_ids);
 for(const r of ranked)append(r.t.id,[...(r.t.required_context_ids??[]),...r.t.context_ids]);
 return {normalized_question:normalize(q),broad_direct_terms:broadDirect,broad_prior_terms:broadPrior,topic_hits:ranked.map(r=>({id:r.t.id,score:r.score,current_terms:r.current,prior_terms:r.prior})),group_selection:groups};
};
const results=fixture.cases.map(c=>{
 const ids=actual.retrieveContextIds(c.question,c.previous_question??undefined);
 const expected=c.expected_support.map(goal=>({goal,acceptable_contexts:fixture.source_basis[goal].any_context,found:fixture.source_basis[goal].any_context.some(id=>ids.includes(id))}));
 const missing=expected.filter(g=>!g.found).map(g=>g.goal);
 const passed=c.expected_empty?ids.length===0:missing.length===0;
 return {...c,actual_context_ids:ids,source_characters:ids.reduce((s,id)=>s+contextById.get(id).paragraphs.reduce((z,p)=>z+(p.reading_text??p.text).length,0),0),expected_results:expected,missing_support:missing,passed,outcome:passed?'pass':c.expected_empty?'irrelevant_routing':ids.length===0?'no_context_false_negative':'nonempty_but_missing_required_support',trace:trace(c.question,c.previous_question)};
});
const category={};for(const r of results){const s=category[r.category]??={cases:0,pass:0,no_context_false_negative:0,nonempty_but_missing_required_support:0,irrelevant_routing:0};s.cases++;s[r.passed?'pass':r.outcome]++;}
const report={version:'independent-router-audit-v6-1',created_at:new Date().toISOString(),network_calls:0,model_calls:0,application_edits:0,execution:'Actual bundled TypeScript retrieveContextIds; diagnostic trace reimplements ranking only for explanation. No model or server used.',fixtures_sha256:sha(await readFile(resolve(here,'audit-fixtures.json'))),input_hashes:Object.fromEntries(paths.map((p,i)=>[p,sha(sourceBytes[i])])),index_version:index.version,packet_context_count:packet.contexts.length,packet_paragraph_count:packet.contexts.reduce((s,c)=>s+c.paragraphs.length,0),packet_unique_sources:new Set(packet.contexts.map(c=>c.source_id)).size,scope:'Hand-selected source-anchored diagnostic fixtures, constructed after reading router and originals. Not a blind benchmark or estimate of real traffic failure rates. English primary; Chinese separately scoped.',category_totals:category,results};
await mkdir(outputDirectory,{recursive:true});
const reportPath=resolve(outputDirectory,'audit-results.json');
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
const baseline=JSON.parse(await readFile(resolve(here,'audit-results.json'),'utf8'));
const baselineById=new Map(baseline.results.map(r=>[r.id,r]));
const baselineOutcomesMatch=results.length===baseline.results.length&&results.every(r=>{const b=baselineById.get(r.id);return b&&r.outcome===b.outcome&&JSON.stringify(r.actual_context_ids)===JSON.stringify(b.actual_context_ids);});
console.log(JSON.stringify({report:'test-results/retrieval/audit-results.json',network_calls:0,model_calls:0,total:results.length,acceptance_passed:results.filter(r=>r.passed).length,acceptance_failed:results.filter(r=>!r.passed).length,baseline_outcomes_match:baselineOutcomesMatch,category_totals:category,note:'Diagnostic cases intentionally expose current defects. Exit status 0 means execution completed, not that acceptance criteria passed. The committed baseline was not overwritten.'},null,2));
