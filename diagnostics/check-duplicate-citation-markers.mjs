import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeReport} from './report-output.mjs';

globalThis.fetch=()=>{throw Error('No network allowed.');};
const compiled=await build({entryPoints:['lib/generation-prompt.ts'],bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const references={'P01-001':{text:'Cash is valuable. A real original passage.'},'P01-002':{text:'Another original passage.'},'P02-001':{text:'A third original passage.'}};
const prepared={messages:[],promptVersion:api.GENERATION_PROMPT_VERSION,evidence:{referencesForValidation:references}};
const paragraph=(text,citations=['P01-001'])=>({text,citations});
const shape=text=>({title:'Title',lead:paragraph(text),sections:[]});
const parse=value=>api.parseGenerationResponse(JSON.stringify(value),prepared);
const rejected=(value,code)=>assert.throws(()=>parse(value),error=>error.name==='GenerationValidationError'&&(!code||error.code===code));
const checks=[];
const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,message:error.message});}};
check('duplicated valid keys are removed, prose and citation order preserved, changes recorded',()=>{
  const value={title:'Title',lead:paragraph('First point (P01-001, P01-002). Second point (P01-002).',['P01-002','P01-001']),sections:[]};
  const before=JSON.stringify(value),out=parse(value);
  assert.equal(out.answer.lead,'First point. Second point. [[P01-002]][[P01-001]]');
  assert.deepEqual(out.answer.reference_keys,['P01-002','P01-001']);assert.equal(JSON.stringify(value),before);
  assert.equal(out.checks.duplicateCitationMarkers.length,2);assert.equal(out.checks.duplicateCitationMarkers[0].paragraph,'lead');
  assert.deepEqual(out.checks.duplicateCitationMarkers[0].referenceKeys,['P01-001','P01-002']);
  assert.equal(out.checks.semanticGroundingChecked,false);
});
check('section path and paragraph-local keys are recorded without global citation inference',()=>{
  const out=parse({title:'Title',lead:paragraph('Opening.'),sections:[{heading:'Detail',paragraphs:[paragraph('Detail (P01-002).',['P01-002'])]}]});
  assert.equal(out.answer.sections[0][1],'Detail. [[P01-002]]');
  assert.equal(out.checks.duplicateCitationMarkers[0].paragraph,'sections.0.paragraphs.0');
  rejected({title:'Title',lead:paragraph('Opening.'),sections:[{heading:'Detail',paragraphs:[paragraph('Detail (P01-001).',['P01-002'])]}]},'unsupported_format');
});
check('known but unlisted keys and unknown keys are never removed or partially accepted',()=>{
  rejected(shape('A point (P01-002).'),'unsupported_format');
  rejected(shape('A point (P01-001, P99-999).'),'unsupported_format');
  rejected({title:'Title',lead:paragraph('A point (P99-999).',['P99-999']),sections:[]},'references');
});
check('mixed prose, bare/bracketed keys, malformed lists and nested/attached groups stay rejected',()=>{
  for(const text of ['A point (see P01-001).','A point (P01-001, explanation).','A point P01-001.','A point [P01-001].','A point (P01-001; P01-002).','A point ((P01-001)).','A point ( (P01-001) ).','word(P01-001)word','A point (P01-001)word'])rejected(shape(text),'unsupported_format');
});
check('quoted citation markers and malformed quotes are never cleaned',()=>{
  for(const [open,close] of [['"','"'],['“','”'],['‘','’'],["'","'"]])rejected(shape(`${open}Cash is valuable (P01-001)${close}.`),'unsupported_format');
  rejected(shape('“Cash is valuable (P01-001).'),'unsupported_format');
});
check('quotes outside a removable marker remain exact and fabricated quotes still fail',()=>{
  const out=parse(shape('The source states “Cash is valuable.” (P01-001).'));
  assert.equal(out.answer.lead,'The source states “Cash is valuable.”. [[P01-001]]');
  assert.deepEqual(out.checks.exactQuotes,[{text:'Cash is valuable.',referenceKey:'P01-001'}]);
  rejected(shape('The source states “Cash is always valuable.” (P01-001).'),'quotation');
});
check('unchanged paragraphs have no extra metadata; apostrophes are ordinary prose',()=>{
  const unchanged=parse(shape("The owner's account."));assert.equal(unchanged.checks.duplicateCitationMarkers,undefined);
  assert.equal(parse(shape("The owner's account (P01-001).")).answer.lead,"The owner's account. [[P01-001]]");
});
check('cleanup cannot evade original paragraph or aggregate section character limits',()=>{
  rejected(shape('a'.repeat(3991)+' (P01-001)'),'length');
  const text='a'.repeat(3977)+' (P01-001).';
  rejected({title:'Title',lead:paragraph('Lead.'),sections:[{heading:'Heading',paragraphs:[paragraph(text),paragraph(text)]}]},'length');
});
check('cleanup cannot evade the original global word limit',()=>{
  const text='w '.repeat(1194)+'(P01-001, P01-002, P02-001).',citations=Object.keys(references);
  rejected({title:'Title',lead:paragraph('Lead.'),sections:[{heading:'Heading',paragraphs:[paragraph(text,citations)]}]},'length');
  const alreadyClean='w '.repeat(1194).trimEnd()+'.';
  assert.ok(parse({title:'Title',lead:paragraph('Lead.'),sections:[{heading:'Heading',paragraphs:[paragraph(alreadyClean,citations)]}]}).answer);
});
check('titles, headings, refusal reasons and legacy flat branches retain existing behavior',()=>{
  rejected({...shape('A point.'),title:'Title (P01-001)'},'unsupported_format');
  rejected({title:'Title',lead:paragraph('Lead.'),sections:[{heading:'Heading (P01-001)',paragraphs:[paragraph('Body.')]}]},'unsupported_format');
  rejected({unavailable:true,reason:'Absent evidence (P01-001).'},'unsupported_format');
  const legacy={title:'Title',answer:'Legacy prose (P01-001). [[P01-001]]'};
  const out=parse(legacy);assert.equal(out.answer.lead,legacy.answer);assert.equal(out.checks.duplicateCitationMarkers,undefined);
});
const report={version:'duplicate-citation-markers-1',promptVersion:api.GENERATION_PROMPT_VERSION,modelCalls:0,scope:'Deterministic presentation, citation authorization, unchanged bounds and exact-quote checks only; no semantic approval.',passed:checks.every(c=>c.passed),checks};
console.log(JSON.stringify({report:await writeReport('duplicate-citation-markers.json',report),...report},null,2));
assert.ok(report.passed,'Duplicate-marker normalization regression failed.');
