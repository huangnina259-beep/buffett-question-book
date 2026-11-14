import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

globalThis.fetch=()=>{throw Error('No network allowed.');};
const app=process.cwd(),here=resolve(app,'diagnostics');
// Keep the comparison reproducible after the candidate is committed. An
// explicit override can compare another baseline without editing fixtures.
const baselineRef=process.env.BUFFETT_BASELINE_REF || 'b0bdcfa7a39f17dd8c65e1669f6161f04d534620';
const head=execFileSync('git',['rev-parse',`${baselineRef}^{commit}`],{encoding:'utf8'}).trim();
const baselineSource=execFileSync('git',['show',`${head}:lib/retrieved-evidence.ts`],{encoding:'utf8'});
const candidateSource=await readFile('lib/retrieved-evidence.ts','utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
const phases={};
for(const [label,source] of Object.entries({baseline:baselineSource,candidate:candidateSource})){
  const compiled=await build({stdin:{contents:"export * from './lib/query-plan.ts'; export * from './lib/retrieved-evidence.ts'; export {buildGenerationPrompt} from './lib/generation-prompt.ts';",resolveDir:app,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'isolated-retriever',setup(build){build.onLoad({filter:/[/\\]retrieved-evidence\.ts$/},()=>({contents:source,loader:'ts',resolveDir:resolve(app,'lib')}));}}]});
  const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  globalThis.comparisonApi=api;globalThis.comparisonReports={};
  for(const filename of ['check-retrieval.mjs','check-method-plan-coverage.mjs']){
    let harness=await readFile(resolve(here,filename),'utf8');
    // Reuse the exact existing cases and whole-original-passage requirements.
    // Only substitute the isolated API and capture reports instead of writing
    // over earlier results. Aggregate assertions are recorded as data below.
    harness=harness.replace(/import \{\s*writeReport\s*\} from '\.\/report-output\.mjs';/,"const writeReport=async(name,report)=>{globalThis.comparisonReports[name]=report;return name;};");
    harness=harness.replace(/^const here=.*$/m,`const here=${JSON.stringify(here)},app=${JSON.stringify(app)};`);
    harness=harness.replace(/^const compiled=.*$/m,'').replace(/^const api=.*$/m,'const api=globalThis.comparisonApi;');
    harness=harness.replace(/^import \{build\} from 'esbuild';$/m,'');
    harness=harness.replace(/import\.meta\.url/g,JSON.stringify(pathToFileURL(resolve(here,filename)).href));
    harness=harness.replace(/^console\.log\(.*$/gm,'');
    harness=harness.replace(/^assert\.ok\((?:report\.passed|passed),.*$/gm,'');
    const reportName=filename==='check-retrieval.mjs'?'retrieval-regression-report.json':'method-plan-coverage.json';
    await import('data:text/javascript;base64,'+Buffer.from(harness+`\nawait writeReport(${JSON.stringify(reportName)},report);\n// ${label} ${filename}`).toString('base64'));
  }
  phases[label]={retrievalVersion:api.RETRIEVAL_VERSION,sourceSha256:hash(source),reports:globalThis.comparisonReports};
}
const rawBefore=phases.baseline.reports['retrieval-regression-report.json'];
const rawAfter=phases.candidate.reports['retrieval-regression-report.json'];
const methodBefore=phases.baseline.reports['method-plan-coverage.json'];
const methodAfter=phases.candidate.reports['method-plan-coverage.json'];
const rawCases=rawBefore.cases.map((b,i)=>{const a=rawAfter.cases[i];assert.equal(a.question,b.question);return {question:b.question,baselinePassed:b.passed,candidatePassed:a.passed,change:b.passed===a.passed?'unchanged':a.passed?'gain':'loss',baselineContexts:b.contextIds,candidateContexts:a.contextIds,baselineAlternatives:b.alternatives,candidateAlternatives:a.alternatives};});
const methodCases=methodBefore.syntheticComponentCases.map((b,i)=>{const a=methodAfter.syntheticComponentCases[i];assert.equal(a.question,b.question);return {question:b.question,plan:b.plan,baselinePassed:b.essentialPassagesPresent,candidatePassed:a.essentialPassagesPresent,baselineMissing:b.matches.filter(p=>!p.contextIds.length).map(p=>p.paragraphId),candidateMissing:a.matches.filter(p=>!p.contextIds.length).map(p=>p.paragraphId),baselineContexts:b.contextIds,candidateContexts:a.contextIds};});
const report={version:'controlled-retrieval-comparison-1',networkCalls:0,baselineCommit:head,scope:'Same current fixtures/corpus/planner parser/writer builder in both phases. Only lib/retrieved-evidence.ts is substituted from exact Git HEAD using esbuild onLoad. No runtime files overwritten. Whole-passage expectations unchanged.',baselineSourceSha256:hash(baselineSource),candidateSourceSha256:hash(candidateSource),rawCases,methodCases,phases};
await mkdir('test-results/backend',{recursive:true});await writeFile('test-results/backend/retrieval-controlled-comparison.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({baselineCommit:head,rawCases:rawCases.map(({question,baselinePassed,candidatePassed,change})=>({question,baselinePassed,candidatePassed,change})),methodCases:methodCases.map(({question,baselinePassed,candidatePassed,candidateMissing})=>({question,baselinePassed,candidatePassed,candidateMissing}))},null,2));
