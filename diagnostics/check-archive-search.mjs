/** Offline development probes. No semantic approval or model/network calls. */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'test-results/archive');
await mkdir(out,{recursive:true});
globalThis.fetch=()=>{throw new Error('Network forbidden in offline retrieval check.');};
const {build}=createRequire(resolve(root,'package.json'))('esbuild');
await build({stdin:{contents:"export * from './lib/retrieved-evidence.ts'; export {buildGenerationPrompt} from './lib/generation-prompt.ts';",resolveDir:root,loader:'ts'},outfile:resolve(out,'search.mjs'),bundle:true,platform:'node',format:'esm'});
const start=performance.now();
const api=await import(pathToFileURL(resolve(out,'search.mjs')).href);
const importMs=performance.now()-start;
const probes=[
 {question:'how to be a great investor'},
 {question:"How do I evaluate a stock's intrinsic value?"},
 {question:'How do owner earnings differ from reported earnings?'},
 {question:'Should I choose an index fund or select individual stocks?'},
 {question:'How does insurance float help Berkshire?'},
 {question:'How do I evaluate a stock?',previous:'How does insurance float help Berkshire?'},
 {question:'Can you give an example?',previous:'How do owner earnings differ from reported earnings?'},
 {question:'How do I bake sourdough bread?'},
];
const results=[];
for(const probe of probes){
 const began=performance.now(),selection=api.searchArchive(probe.question,probe.previous);
 const retrievalMs=performance.now()-began;
 const prompt=api.buildGenerationPrompt(probe.question,probe.previous);
 assert.ok(selection.contexts.length<=6);
 assert.ok(selection.sourceCharacters<=42000);
 assert.ok(Object.values(prompt.evidence.referencesForValidation).every(p=>p.text.trim()));
 assert.deepEqual(prompt.evidence.contextIds,selection.contexts.map(c=>c.context_id));
 const publicKeys=Object.keys(prompt.evidence.publicReferences);
 assert.deepEqual(publicKeys,Object.keys(prompt.evidence.referencesForValidation));
 const seen=new Set(selection.contexts.map(c=>c.context_id));
 for(const context of selection.contexts)for(const id of context.required_companion_context_ids??[])assert.ok(seen.has(id));
 results.push({...probe,retrievalMs,usedPreviousQuestion:selection.usedPreviousQuestion,scoredDocuments:selection.scoredDocuments,sourceCharacters:selection.sourceCharacters,promptBytes:Buffer.byteLength(JSON.stringify(prompt.messages)),contexts:selection.contexts.map(c=>({id:c.context_id,source_id:c.source_id,title:c.title,paragraphs:c.paragraphs.length,characters:c.paragraphs.reduce((n,p)=>n+(p.reading_text??p.text).length,0)}))});
}
assert.equal(results[5].usedPreviousQuestion,false);
assert.equal(results[6].usedPreviousQuestion,true);
globalThis.gc?.();
const report={scope:'Development retrieval probes and structural checks; not answer-quality acceptance.',modelCalls:0,networkCalls:0,bundle:api.LIVE_EVIDENCE_VERSION,importMs,memory:process.memoryUsage(),results};
await writeFile(resolve(out,'development.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
