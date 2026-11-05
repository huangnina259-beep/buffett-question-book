/** Portable, no-inference entry point. Requires dependencies already installed. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const app=resolve(process.env.BUFFETT_APP_ROOT || resolve(here,'..'));
const environment={...process.env,GENERATION_ENABLED:'false',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_CF_FETCH_ENABLED:'false'};
for(const key of Object.keys(environment))if(key.startsWith('MODEL_'))delete environment[key];
const steps=[
  ['TypeScript',[resolve(app,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false']],
  ['Backend state, budgets and reviewer gate',[resolve(here,'offline-backend-checks.mjs')]],
  ['Parser and quotation rules',[resolve(here,'flat-writer-32-checks.mjs')]],
  ['Bounded transport',[resolve(here,'stream-check.mjs')]],
  ['Retrieval routing and snapshot integrity',[resolve(here,'check-retrieval.mjs')]],
  ['Saved-response parser replay',[resolve(here,'replay-saved-outputs.mjs')]],
];
for(const [name,args] of steps){
  console.log(name);
  const result=spawnSync(process.execPath,args,{cwd:app,env:environment,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
console.log('Offline checks complete. No provider calls, credential files or existing session databases were used.');
