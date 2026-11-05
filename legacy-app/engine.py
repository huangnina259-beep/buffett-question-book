"""Question -> research plan -> original contexts -> answer -> independent check."""
from __future__ import annotations
import hashlib, json, re, time
from pathlib import Path
from provider import CodexProvider, ProviderError
from prompts import VERSION, PLANNER, WRITER, REVIEWER, PLAN_SCHEMA, ANSWER_SCHEMA, REVIEW_SCHEMA
from retrieval import Retriever

def blocks(answer):
    yield from answer.get('short_answer', [])
    for s in answer.get('sections', []): yield from s.get('paragraphs', [])
    yield from answer.get('practical_implications', [])

def normalize(text): return re.sub(r'\s+', ' ', text).strip()

def model_context(c):
    """Keep all source wording, but do not spend model context on repeated hashes."""
    result={k:c[k] for k in ['id','title','text','dates','review_status','boundary'] if k in c}
    result['paragraph_attribution']=[]
    for p in c.get('paragraphs',[]):
        row={k:p[k] for k in ['id','text_start','text_end','speaker','candidate_speaker','speaker_label','attribution_basis','author_attribution'] if p.get(k) is not None}
        if 'speaker' in p: row['speaker']=p['speaker']
        result['paragraph_attribution'].append(row)
    quality=c.get('source_quality',{})
    result['source_issues']=quality.get('issues',[])
    return result

def validate_citations(answer, contexts):
    sources={c['id']:c for c in contexts}; issues=[]; seen=set()
    practice_ids={id(b) for b in answer.get('practical_implications',[])}
    for b in blocks(answer):
        bid=b.get('id','')
        if not bid or bid in seen: issues.append({'block_id':bid,'issue':'Block ID absent or duplicated.','severity':'material'})
        seen.add(bid)
        if not b.get('text','').strip(): issues.append({'block_id':bid,'issue':'Empty answer paragraph.','severity':'material'})
        if not b.get('citations') and (answer.get('evidence_status')=='sufficient' or id(b) in practice_ids):
            issues.append({'block_id':bid,'issue':'A substantive sufficient-answer paragraph has no source citation.','severity':'material'})
        for cite in b.get('citations',[]):
            c=sources.get(cite.get('source_id')); quote=normalize(cite.get('quote',''))
            if not c or len(quote)<12 or quote not in normalize(c['text']):
                issues.append({'block_id':bid,'issue':'Citation must identify a supplied source and an exact contiguous short excerpt from its text.','severity':'critical'})
            elif len(quote.split())>25:
                issues.append({'block_id':bid,'issue':'Citation locator is too long; shorten it without changing its wording.','severity':'material'})
    if not answer.get('short_answer'): issues.append({'block_id':'short_answer','issue':'A direct short answer is required.','severity':'material'})
    return issues

def source_view(c):
    dates=c.get('dates',{})
    return {'id':c['id'],'title':c.get('title',c['id']),'source_url':c.get('source_url',''),
            'local_url':'/library/'+c.get('local_source_url',''), 'text':c['text'],
            'quality_note':c.get('review_status','Original extraction; not a blanket semantic approval.'),
            'event_date':dates.get('event_date') or ('Report year '+str(dates['report_year']) if dates.get('report_year') else ''),
            'dates':dates,'locator':c.get('locator',{}),'paragraphs':c.get('paragraphs',[]),
            'boundary':c.get('boundary',''),'unit_ids':c.get('unit_ids',[]),
            'source_raw_sha256':c.get('source_raw_sha256'),
            'context_text_sha256':hashlib.sha256(c['text'].encode()).hexdigest(),
            'source_raw_path':c.get('source_raw_path'),
            'complete_within_boundary':c.get('complete_within_boundary',False),
            'omitted_units':c.get('omitted_units',[]),'source_quality':c.get('source_quality',{})}

class Engine:
    def __init__(self, library, runtime):
        self.retriever=Retriever(library)
        self.provider=CodexProvider(runtime)

    def answer(self, question, history=None, reference_contexts=None, progress=None, capture_trace=False):
        started=time.monotonic(); history=history or []; calls=[]; trace=[]
        def update(stage,msg):
            if progress: progress(stage,msg)
        def call(prompt,schema):
            value,meta=self.provider.complete(prompt,schema); calls.append(meta)
            if capture_trace:
                trace.append({'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),
                              'structured_response':json.loads(json.dumps(value)), 'execution':meta})
            return value
        if not isinstance(question,str) or not 3<=len(question.strip())<=2000:
            raise ValueError('Enter a question between 3 and 2,000 characters.')
        question=question.strip()
        history=[{'question':str(x.get('question',''))[:2000], 'answer':str(x.get('answer',''))[:6000]} for x in history[-4:] if isinstance(x,dict)]
        request={'question':question,'conversation_history':history}
        update('planning','Understanding the question and the distinctions it needs.')
        plan=call(PLANNER+'\nREQUEST:\n'+json.dumps(request,ensure_ascii=False),PLAN_SCHEMA)
        if plan['domain']=='out_of_scope':
            return {'question':question,'answer':{'title':'Outside this library’s scope',
                'short_answer':[{'id':'scope','text':'This library answers questions about Buffett’s published letters, meetings and related source material. I cannot substantiate an answer to this question from that collection.','citations':[]}],
                'sections':[],'practical_implications':[],'limitations':['No relevant source search or current-fact assessment was performed.'],
                'follow_up_questions':[],'evidence_status':'insufficient'},'sources':[],
                'review':{'status':'scope_response','notes':['Scope routing; no factual answer generated.']},
                'scope':{'mode':'out_of_scope'},'timing':{'seconds':round(time.monotonic()-started,1),'calls':calls},'research_plan':plan}
        update('retrieving','Finding original passages, including conditions and contrasting cases.')
        if reference_contexts is None:
            packet=self.retriever.search(plan['standalone_question'],queries=plan['queries'][:7],limit=8,budget_chars=65000)
        else:
            packet={'selected_contexts':reference_contexts,'candidate_pool':[],
                    'scope':{'mode':'independently_selected_reference_contexts','selected_contexts':len(reference_contexts),
                             'search_is_exhaustive_topic_review':False},'gaps':{'limitations':['Reference packet experiment; not automatic retrieval.']}}
        contexts=packet['selected_contexts']
        # Send complete original text and attribution metadata; exclude editorial claims and grading rubrics.
        model_contexts=[model_context(c) for c in contexts]
        evidence={'request':request,'question_understanding':plan,'original_contexts':model_contexts,
                  'retrieval_limits':{'limitations':packet['gaps'].get('limitations',[]),
                     'whole_contexts_omitted_for_budget':len(packet['gaps'].get('budget_omissions',[]))},
                  'current_market_data_available':False}
        original_payload=json.dumps(evidence,ensure_ascii=False)
        update('writing','Reading the selected contexts and composing a supported explanation.')
        answer=call(WRITER+'\nDATA:\n'+original_payload,ANSWER_SCHEMA)
        reviews=[]; released=False
        for attempt in range(2):
            update('checking','Checking the answer’s claims, citations and conditions against the passages.')
            mechanical=validate_citations(answer,contexts)
            review=call(REVIEWER+'\nDATA:\n'+original_payload+'\nPROPOSED ANSWER:\n'+json.dumps(answer,ensure_ascii=False),REVIEW_SCHEMA)
            if mechanical:
                review['pass']=False;review['issues']=mechanical+review['issues']
            reviews.append(review)
            if review['pass'] and not any(i['severity'] in ('critical','material') for i in review['issues']):
                released=True;break
            if attempt==0:
                update('writing','Revising the answer to resolve source-check findings.')
                answer=call(WRITER+'\nDATA:\n'+original_payload+'\nDRAFT TO REPAIR:\n'+json.dumps(answer,ensure_ascii=False)+'\nREQUIRED CORRECTIONS:\n'+json.dumps(review,ensure_ascii=False),ANSWER_SCHEMA)
        if not released:
            answer={'title':'An answer could not yet be substantiated',
                    'short_answer':[{'id':'withheld','text':'I found material related to your question, but the draft did not pass the source checks. The passages are available below; the unsupported draft has been withheld.','citations':[]}],
                    'sections':[],'practical_implications':[],
                    'limitations':['The selected evidence or its interpretation needs further review. This does not establish that Buffett never addressed the question.'],
                    'follow_up_questions':[],'evidence_status':'insufficient'}
        result={'question':question,'answer':answer,'sources':[source_view(c) for c in contexts],
                'review':{'status':'model_checked_selected_passages' if released else 'withheld',
                          'notes':['Separate model pass checked this answer against the retrieved text. This is not human review, audio authentication or complete topic coverage.'],
                          'checks':reviews},
                'scope':packet['scope'],'gaps':packet['gaps'],'research_plan':plan,
                'retrieval':{'candidate_pool':packet['candidate_pool'],'selected_context_ids':[c['id'] for c in contexts]},
                'timing':{'seconds':round(time.monotonic()-started,1),'calls':calls},
                'engine_version':VERSION,'current_market_data_assessed':False}
        if capture_trace: result['evaluation_trace']=trace
        return result

def frozen_hashes(folder):
    return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(folder).glob('*.py')
            if p.name in {'engine.py','provider.py','prompts.py','retrieval.py'}}
