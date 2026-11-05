import { writeReport } from './report-output.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),app=resolve(process.env.BUFFETT_APP_ROOT || resolve(here,'..'));
const require=createRequire(resolve(app,'package.json'));
const compiled=await require('esbuild').build({entryPoints:[resolve(app,'lib/generation-prompt.ts')],bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const source=await readFile(resolve(app,'lib/content/live-evidence-packets.json'));
const snapshot=JSON.parse(await readFile(resolve(here,'fixtures/source-hashes.json'),'utf8'));
const appIndex=await readFile(resolve(app,'lib/content/live-retrieval-index.json'));

const sha=value=>createHash('sha256').update(value).digest('hex');
const cases=[
 {question:'Is all outside credit a problem for a finance company?',required:['meeting-2002-boundary']},
 {question:'Does Buffett require a finance company to avoid external credit?',required:['meeting-2002-boundary']},
 {question:'Why did using Berkshire credit matter in the unnamed finance company example?',required:['meeting-2002-boundary']},
 {question:'What did Buffett say about continuing funding?',required:['meeting-2002-boundary']},
 {question:'how to evaluate a stock',required:['letter-1992-0074-0085','letter-1991-0045-0055','letter-1986-0285-0297','letter-1986-0209-0210','letter-1991-0031-0037'],exactCount:5},
 {question:'Explain Scott Fetzer purchase accounting and Company O versus Company N.',required:['letter-1986-0154-0297']},
 {question:'Will it rain tomorrow?',required:[],exactCount:0},
 {question:'how to be a great investor',required:[],exactCount:0,knownGap:true},
];
const report={version:'live-v3-finance-retrieval-regression-1',networkCalls:0,scope:'Routing and byte identity against this handoff snapshot only; no full-archive or semantic quality claim.',packetSha256:sha(source),indexSha256:sha(appIndex),packetMatchesSnapshot:sha(source)===snapshot.packetSha256,indexMatchesSnapshot:sha(appIndex)===snapshot.indexSha256,cases:[]};
for(const item of cases){const prompt=api.buildGenerationPrompt(item.question);const ids=prompt.evidence.contextIds;report.cases.push({question:item.question,knownGap:item.knownGap===true,contextIds:ids,sourceCharacters:prompt.evidence.counts.readingParagraphCharacters,passed:item.required.every(id=>ids.includes(id))&&(item.exactCount===undefined||ids.length===item.exactCount)&&ids.length<=8&&prompt.evidence.counts.readingParagraphCharacters<=60000});}
report.passed=report.packetMatchesSnapshot&&report.indexMatchesSnapshot&&report.cases.every(item=>item.passed);
await writeReport('retrieval-regression-report.json', report);
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,sourcePacketMatchesSnapshot:report.packetMatchesSnapshot}));
assert.ok(report.passed,'Retrieval regression failed; see report.');
