import { writeReport } from './report-output.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),app=resolve(process.env.BUFFETT_APP_ROOT || resolve(here,'..'));
const require=createRequire(resolve(app,'package.json'));
globalThis.fetch=()=>{throw new Error('Network is forbidden in retrieval regression checks.');};
const compiled=await require('esbuild').build({entryPoints:[resolve(app,'lib/generation-prompt.ts')],bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const source=await readFile(resolve(app,'lib/content/live-evidence-packets.json'));
const snapshot=JSON.parse(await readFile(resolve(here,'fixtures/source-hashes.json'),'utf8'));
const appIndex=await readFile(resolve(app,'lib/content/live-retrieval-index.json'));
const archiveIndex=await readFile(resolve(app,'lib/content/archive-index.json'));
const archivePassages=JSON.parse(await readFile(resolve(here,'fixtures/archive-essential-passages.json'),'utf8'));
const packet=JSON.parse(source),byContext=new Map(packet.contexts.map(c=>[c.context_id,c]));
const sha=value=>createHash('sha256').update(value).digest('hex');
const normalize=text=>text.replace(/\s+/g,' ').trim();
const paragraphs=(contextId,ids)=>{
  const context=byContext.get(contextId);assert.ok(context,contextId);
  return ids.map(id=>{
    const p=context.paragraphs.find(p=>p.id===id);assert.ok(p,`Missing immutable fixture paragraph ${id}`);
    return {sourceId:context.source_id,id,text:p.reading_text??p.text};
  });
};
const finance=paragraphs('meeting-2002-boundary',['cnbc-meeting-2002-afternoon-ch18-p002','cnbc-meeting-2002-afternoon-ch18-p003','cnbc-meeting-2002-afternoon-ch18-p011','cnbc-meeting-2002-afternoon-ch18-p012']);
const owner=paragraphs('letter-1986-0285-0297',['berkshire-letter-1986:u0285','berkshire-letter-1986:u0286','berkshire-letter-1986:u0287','berkshire-letter-1986:u0288']);
const ownerCompanion=paragraphs('letter-1986-0209-0210',['berkshire-letter-1986:u0209','berkshire-letter-1986:u0210']);
const stock=paragraphs('letter-1992-0074-0085',['berkshire-letter-1992:u0074','berkshire-letter-1992:u0080','berkshire-letter-1992:u0081','berkshire-letter-1992:u0084','berkshire-letter-1992:u0085']);
const franchise=paragraphs('letter-1991-0031-0037',['berkshire-letter-1991:u0033','berkshire-letter-1991:u0034','berkshire-letter-1991:u0035']);
// These alternatives come from the previously published user-question source
// basis, plus the directly relevant full 2002 chapter read during this candidate
// review. They are known regressions, not a blind evaluation of archive ranking.
const investingAlternatives=[
  archivePassages.greatInvestorAlternative,
  paragraphs('letter-1996-0098-0118',['berkshire-letter-1996:u0099','berkshire-letter-1996:u0114','berkshire-letter-1996:u0116']),
  paragraphs('letter-2013-investing-p001-p040',['letter-2013-investing-p013','letter-2013-investing-p014','letter-2013-investing-p025']),
  paragraphs('meeting-2019-learning',['cnbc-meeting-2019-afternoon-ch08-p006','cnbc-meeting-2019-afternoon-ch08-p007','cnbc-meeting-2019-afternoon-ch08-p011','cnbc-meeting-2019-afternoon-ch08-p013']),
];
const cases=[
  ...['Is all outside credit a problem for a finance company?','Does Buffett require a finance company to avoid external credit?','Why did using Berkshire credit matter in the unnamed finance company example?','What did Buffett say about continuing funding?'].map(question=>({question,alternatives:[finance]})),
  {question:'how to evaluate a stock',alternatives:[[...stock,...owner,...ownerCompanion,...franchise]]},
  {question:'Explain Scott Fetzer purchase accounting and Company O versus Company N.',alternatives:[[...owner,...ownerCompanion]]},
  {question:'How do I calculate owner earnings?',alternatives:[[...owner,...ownerCompanion]]},
  {question:'Will it rain tomorrow?',mustBeEmpty:true},
  {question:'how to be a great investor',alternatives:investingAlternatives},
];
function locate(contexts,expected){
  // Context IDs and paragraph boundaries may differ in the canonical archive.
  // Same source ID alone is insufficient: every complete expected passage,
  // including its conditions, must remain a literal whitespace-normalized span.
  return contexts.filter(c=>c.source_id===expected.sourceId&&normalize(c.paragraphs.map(p=>p.text).join('\n')).includes(normalize(expected.text))).map(c=>c.context_id);
}
const report={version:'archive-essential-passages-regression-2',networkCalls:0,scope:'Known original-passage retrieval regressions and immutable legacy snapshot identity. Not a held-out quality test, full-source audit, or generated-answer evaluation.',packetSha256:sha(source),indexSha256:sha(appIndex),archiveIndexSha256:sha(archiveIndex),packetMatchesSnapshot:sha(source)===snapshot.packetSha256,indexMatchesSnapshot:sha(appIndex)===snapshot.indexSha256,cases:[]};
for(const item of cases){
  const prepared=api.buildGenerationPrompt(item.question),contexts=JSON.parse(prepared.evidence.messages[1].content).source_contexts;
  const alternatives=(item.alternatives??[]).map(expected=>expected.map(p=>({paragraphId:p.id,matchingContextIds:locate(contexts,p)})));
  const essentialPassagesPresent=item.mustBeEmpty?contexts.length===0:alternatives.some(group=>group.every(p=>p.matchingContextIds.length));
  // Whenever the owner-earnings excerpt is selected, require its O/N identity
  // companion or an enclosing full appendix containing both original passages.
  const hasOwnerExcerpt=owner.every(p=>locate(contexts,p).length);
  const companionPreserved=!hasOwnerExcerpt||ownerCompanion.every(p=>locate(contexts,p).length);
  const withinLimits=contexts.length<=6&&prepared.evidence.counts.readingParagraphCharacters<=42000;
  report.cases.push({question:item.question,contextIds:prepared.evidence.contextIds,sourceCharacters:prepared.evidence.counts.readingParagraphCharacters,alternatives,essentialPassagesPresent,companionPreserved,withinLimits,passed:essentialPassagesPresent&&companionPreserved&&withinLimits});
}
report.passed=report.packetMatchesSnapshot&&report.indexMatchesSnapshot&&report.cases.every(item=>item.passed);
await writeReport('retrieval-regression-report.json',report);
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,sourcePacketMatchesSnapshot:report.packetMatchesSnapshot,legacyIndexMatchesSnapshot:report.indexMatchesSnapshot,failures:report.cases.filter(c=>!c.passed).map(c=>({question:c.question,essentialPassagesPresent:c.essentialPassagesPresent,companionPreserved:c.companionPreserved,withinLimits:c.withinLimits}))},null,2));
assert.ok(report.passed,'Essential original-passage retrieval regression failed; see test-results/backend/retrieval-regression-report.json.');
