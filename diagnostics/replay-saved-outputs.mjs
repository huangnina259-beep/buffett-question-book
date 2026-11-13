import { writeReport } from './report-output.mjs';
/** Reparse saved text only. This script cannot regenerate or semantically approve it. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const bindings=JSON.parse(await readFile(resolve(here,'fixtures/historical-evidence-bindings.json'),'utf8'));
const packetBytes=await readFile(resolve(app,'lib/content/live-evidence-packets.json'));
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(sha(packetBytes),bindings.legacyPacketSha256,'Historical source packet changed.');
const packet=JSON.parse(packetBytes),allReferences=new Map();
for(const [i,context] of packet.contexts.entries())for(const [j,p] of context.paragraphs.entries()){
  allReferences.set(`P${String(i+1).padStart(2,'0')}-${String(j+1).padStart(3,'0')}`,{text:p.reading_text??p.text});
}
const cases=[];
for(const item of fixtures.cases){
  const binding=bindings.cases.find(c=>c.id===item.id);assert.ok(binding,'Missing original request evidence binding.');
  const referencesForValidation=Object.fromEntries(binding.referenceKeys.map(key=>{assert.ok(allReferences.has(key));return[key,allReferences.get(key)];}));
  const referenceTextSha256=sha(JSON.stringify(binding.referenceKeys.map(key=>[key,referencesForValidation[key].text])));
  assert.equal(referenceTextSha256,binding.referenceTextSha256,'Historical citation text mapping changed.');
  // Only the current parser runs. The original request's key-to-passage map,
  // evidence selection and bundle identity are immutable, not re-retrieved.
  const prepared={evidence:{referencesForValidation,bundleHash:binding.originalEvidenceBundleHash,contextIds:binding.contextIds}};
  const originalEvidence={bundleHash:binding.originalEvidenceBundleHash,contextIds:binding.contextIds,referenceCount:binding.referenceKeys.length,referenceTextSha256};
  try{
    const parsed=api.parseGenerationResponse(item.text,prepared);
    cases.push({id:item.id,originalEvidence,historicalValidationCode:item.validationCode,currentResult:'accepted',unavailable:'unavailable' in parsed,
      normalizationCount:parsed.checks?.normalizations.length??0,semanticApproval:false});
  }catch(error){
    cases.push({id:item.id,originalEvidence,historicalValidationCode:item.validationCode,currentResult:'rejected',currentValidationCode:error.code??'unknown',semanticApproval:false});
  }
}
// The invalid-JSON historical response must still fail; keep the other outcomes
// visible because format normalization deliberately changed after those samples.
assert.equal(cases.find(item=>item.id==='stock-evaluation-qwen')?.currentValidationCode,'json');
const report={scope:'Current-parser replay of three immutable historical outputs bound to their original request evidence; no current retrieval, inference or semantic review.',promptVersion:api.GENERATION_PROMPT_VERSION,legacyPacketSha256:sha(packetBytes),networkCalls:0,cases};
await writeReport('saved-output-replay-report.json', report);
console.log(JSON.stringify(report,null,2));
