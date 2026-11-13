import { writeReport } from './report-output.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(process.env.BUFFETT_APP_ROOT || resolve(here, '..'));
const { build } = createRequire(resolve(app, 'package.json'))('esbuild');
const temp = await mkdtemp(resolve(here, '.flat-writer-'));
const checks = [];
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { networkCalls++; throw new Error('Network is forbidden in this offline check.'); };
try {
  await build({stdin:{contents:"export * from './lib/generation-prompt.ts'; export {parseGeneratedAnswer} from './lib/generation-contract.ts';",resolveDir:app,loader:'ts'},outfile:resolve(temp,'prompt.mjs'),bundle:true,platform:'node',format:'esm'});
  const { buildGenerationPrompt, parseGenerationResponse, parseGeneratedAnswer, GENERATION_PROMPT_VERSION } = await import(pathToFileURL(resolve(temp,'prompt.mjs')).href);
  const prepared = buildGenerationPrompt('How do I evaluate a stock?');
  const keys = Object.keys(prepared.evidence.referencesForValidation);
  assert.ok(keys.length >= 33);
  const cite = key => '[[' + key + ']]';
  const opening = 'Mechanical fixture opening, with ordinary punctuation: owner’s cash; Buffett\'s example. ' + cite(keys[0]);
  const detail = 'A separate mechanical fixture paragraph. ' + cite(keys[1]);
  const answer = opening + '\n\n## Source detail\n\n' + detail;
  const parse = (value) => parseGenerationResponse(JSON.stringify(value), prepared);
  const valid = {title:'Mechanical fixture',answer};
  const check = (name, fn) => {
    try { fn(); checks.push({name,passed:true}); }
    catch(error) { checks.push({name,passed:false,failure:error.message}); }
  };
  const rejected = (value, expectedCode) => assert.throws(() => parse(value), error => error.name === 'GenerationValidationError' && (!expectedCode || error.code === expectedCode));
  check('current paragraph-object response permits a cited nonempty lead without padding sections', () => {
    const paragraph={text:'Mechanical narrow answer.',citations:[keys[0]]};
    const out=parse({title:'Narrow fixture',lead:paragraph,sections:[]});
    assert.equal(out.answer.lead,paragraph.text+' '+cite(keys[0]));assert.deepEqual(out.answer.sections,[]);
    assert.equal(out.checks.semanticGroundingChecked,false);
  });
  check('lead-only object still rejects empty prose, missing citations and invented quotation', () => {
    const paragraph={text:'Mechanical narrow answer.',citations:[keys[0]]};
    rejected({title:'Fixture',lead:{...paragraph,text:' '},sections:[]},'structure');
    rejected({title:'Fixture',lead:{...paragraph,citations:[]},sections:[]},'references');
    rejected({title:'Fixture',lead:{...paragraph,citations:['P99-999']},sections:[]},'references');
    rejected({title:'Fixture',lead:{...paragraph,text:'“A fabricated unsupported quotation.”'},sections:[]},'quotation');
    rejected({title:'Fixture',lead:paragraph,sections:[{heading:'Padding',paragraphs:[]}]},'structure');
  });
  check('two-string response preserves every prose word and explicit citation when splitting headings', () => {
    const out = parse(valid);
    assert.equal(out.answer.lead,opening);
    assert.deepEqual(out.answer.sections,[['Source detail',detail]]);
    assert.deepEqual(out.answer.reference_keys,[keys[0],keys[1]]);
    assert.equal(out.checks.semanticGroundingChecked,false);
  });
  check('standard JSON fence is accepted without content repair', () => {
    assert.deepEqual(parseGenerationResponse('```json\n'+JSON.stringify(valid)+'\n```',prepared),parse(valid));
  });
  check('32 known paragraph keys are accepted; 33 are rejected', () => {
    const many = count => 'A mechanically cited fixture. '+keys.slice(0,count).map(cite).join('');
    assert.equal(parse({...valid,answer:many(32)+'\n\n## Source detail\n\n'+detail}).answer.reference_keys.length,32);
    rejected({...valid,answer:many(33)+'\n\n## Source detail\n\n'+detail},'references');
  });
  check('an uncited opening is rejected even when the next section is cited', () => rejected({...valid,answer:'An unsupported opening.\n\n## Source detail\n\n'+detail},'uncited_paragraph'));
  check('one cited opening cannot authorize a second uncited opening paragraph', () => rejected({...valid,answer:opening+'\n\nAn uncited additional opening.\n\n## Source detail\n\n'+detail},'uncited_paragraph'));
  check('an unknown source key is rejected rather than repaired', () => rejected({...valid,answer:answer.replace(cite(keys[0]),'[[P99-999]]')},'references'));
  check('a fabricated quotation is rejected despite a valid source key', () => rejected({...valid,answer:answer.replace('Mechanical fixture opening','“This is a fabricated quotation absent from every source.”')},'quotation'));
  check('a heading-first answer is accepted with an empty lead and cited nonempty section', () => {
    const out=parse({...valid,answer:'## Source detail\n\n'+detail});
    assert.equal(out.answer.lead,'');
    assert.deepEqual(out.answer.sections,[['Source detail',detail]]);
  });
  check('all-empty or all-blank answer is rejected; empty section never substitutes for prose', () => {
    rejected({...valid,answer:''},'structure');
    rejected({...valid,answer:' \n\n '},'structure');
    rejected({...valid,answer:'## Empty section'},'structure');
    rejected({title:'Blank fixture',lead:'',sections:[]},'structure');
    rejected({title:'Blank fixture',lead:' ',sections:[['Detail',detail]]},'structure');
  });
  check('a heading with no body is rejected', () => rejected({...valid,answer:answer+'\n\n## Empty section'}));
  check('citations in headings are rejected', () => rejected({...valid,answer:opening+'\n\n## Source detail '+cite(keys[0])+'\n\n'+detail},'unsupported_format'));
  check('duplicate headings are rejected', () => rejected({...valid,answer:answer+'\n\n## source detail\n\n'+detail},'structure'));
  check('third-level Markdown heading cannot masquerade as cited prose', () => rejected({...valid,answer:answer+'\n\n### Unsupported heading '+cite(keys[0])}));
  check('heading with attached prose cannot masquerade as a normal paragraph', () => rejected({...valid,answer:answer+'\n\n## Attached heading\n'+detail}));
  check('optional-heading prose-only response matches the written prompt contract', () => {
    const out=parse({...valid,answer:opening+'\n\n'+detail});
    assert.equal(out.answer.lead,opening+'\n\n'+detail);
    assert.deepEqual(out.answer.sections,[]);
  });
  check('extra JSON fields are rejected', () => rejected({...valid,confidence:'verified'},'structure'));
  check('HTML and external links remain prohibited', () => {
    rejected({...valid,answer:answer+' <script>alert(1)</script>'},'unsupported_format');
    rejected({...valid,answer:answer+' https://example.com'},'unsupported_format');
  });
  const reference={text:'A business can deliver cash to its owners under these conditions; this is a fixture. It depends on investment.'};
  const quoteAnswer=(quote,extra={})=>({title:'Quotation fixture',lead:'The source says '+quote+' [[P01-001]]',sections:[],reference_keys:['P01-001'],...extra});
  const parseQuote=(value,references={'P01-001':reference})=>parseGeneratedAnswer(JSON.stringify(value),{references});
  check('only a nonmatching final period or comma moves outside every supported quote delimiter', () => {
    for(const [open,close] of [['"','"'],['“','”'],['‘','’'],["'","'"]]){
      for(const punctuation of ['.',',']){
        const before=open+'A business can deliver cash'+punctuation+close;
        const after=open+'A business can deliver cash'+close+punctuation;
        const out=parseQuote(quoteAnswer(before));
        assert.equal(out.answer.lead,'The source says '+after+' [[P01-001]]');
        assert.deepEqual(out.checks.exactQuotes,[{text:'A business can deliver cash',referenceKey:'P01-001'}]);
        assert.deepEqual(out.checks.normalizations,[{kind:'quote_terminal_punctuation_moved',before,after,referenceKey:'P01-001'}]);
      }
    }
  });
  check('an exact quote keeps its punctuation and needs no normalization', () => {
    const value=quoteAnswer('"It depends on investment."');
    const out=parseQuote(value);
    assert.equal(out.answer.lead,value.lead);
    assert.deepEqual(out.checks.normalizations,[]);
    assert.equal(out.checks.exactQuotes[0].text,'It depends on investment.');
  });
  check('a full exact match in any cited source wins over punctuation normalization', () => {
    const value=quoteAnswer('"A business can deliver cash."',{lead:'The source says "A business can deliver cash." [[P01-001]][[P01-002]]',reference_keys:['P01-001','P01-002']});
    const out=parseQuote(value,{'P01-001':reference,'P01-002':{text:'A business can deliver cash.'}});
    assert.equal(out.answer.lead,value.lead);
    assert.deepEqual(out.checks.normalizations,[]);
    assert.equal(out.checks.exactQuotes[0].referenceKey,'P01-002');
  });
  check('punctuation normalization cannot authorize invented words, other punctuation or uncited sources', () => {
    for(const quote of ['"A business always delivers cash."','"A business can deliver cash!"','"A business can deliver cash?"','"A business can deliver cash;"'])
      assert.throws(()=>parseQuote(quoteAnswer(quote)),error=>error.code==='quotation');
    assert.throws(()=>parseQuote(quoteAnswer('"Not in the cited source."'),{'P01-001':reference,'P01-002':{text:'Not in the cited source'}}),error=>error.code==='quotation');
  });
  check('multiple quotation moves preserve paragraphs, apostrophes, words and citation positions', () => {
    const body='The owner\'s account says “A business can deliver cash.” then \'It depends on investment,\' [[P01-001]]';
    const out=parseQuote(quoteAnswer('"It depends on investment."',{lead:'',sections:[['Detail',body+'\n\n'+body]]}));
    const expected='The owner\'s account says “A business can deliver cash”. then \'It depends on investment\', [[P01-001]]';
    assert.equal(out.answer.sections[0][1],expected+'\n\n'+expected);
    assert.equal(out.checks.normalizations.length,4);
    assert.deepEqual(out.answer.reference_keys,['P01-001']);
  });
  const report={version:'flat-writer-3.2-offline-1',promptVersion:GENERATION_PROMPT_VERSION,networkCalls,validationScope:'Format, source-key and exact-quotation checks only; this is not semantic validation.',passed:checks.every(check=>check.passed),checks};
  await writeReport('flat-writer-32-report.json', report);
  console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
} finally {
  globalThis.fetch=originalFetch;
  await rm(temp,{recursive:true,force:true});
}
