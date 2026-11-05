import { writeReport } from './report-output.mjs';
/** Reparse saved text only. This script cannot regenerate or semantically approve it. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const app=resolve(process.env.BUFFETT_APP_ROOT || resolve(here,'..'));
const {build}=createRequire(resolve(app,'package.json'))('esbuild');
globalThis.fetch=()=>{throw new Error('Network is forbidden in saved-response replay.');};
const compiled=await build({entryPoints:[resolve(app,'lib/generation-prompt.ts')],bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const fixtures=JSON.parse(await readFile(resolve(here,'fixtures/saved-model-outputs.json'),'utf8'));
const cases=[];
for(const item of fixtures.cases){
  const prepared=api.buildGenerationPrompt(item.question);
  try{
    const parsed=api.parseGenerationResponse(item.text,prepared);
    cases.push({id:item.id,historicalValidationCode:item.validationCode,currentResult:'accepted',unavailable:'unavailable' in parsed,
      normalizationCount:parsed.checks?.normalizations.length??0,semanticApproval:false});
  }catch(error){
    cases.push({id:item.id,historicalValidationCode:item.validationCode,currentResult:'rejected',currentValidationCode:error.code??'unknown',semanticApproval:false});
  }
}
// The invalid-JSON historical response must still fail; keep the other outcomes
// visible because format normalization deliberately changed after those samples.
assert.equal(cases.find(item=>item.id==='stock-evaluation-qwen')?.currentValidationCode,'json');
const report={scope:'Offline parser replay of three immutable historical outputs; no inference or semantic review.',promptVersion:api.GENERATION_PROMPT_VERSION,networkCalls:0,cases};
await writeReport('saved-output-replay-report.json', report);
console.log(JSON.stringify(report,null,2));
