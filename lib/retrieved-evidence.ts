/** Server-only full-archive search; source payloads are loaded after ranking. */
import indexData from './content/archive-index.json';
import { archiveShards } from './content/archive-shards';
import type { EvidencePrompt, PublicEvidenceReference } from './evidence-prompt';

type Paragraph = { id: string; unit_id?: string; speaker: string | null; speaker_basis?: string; text: string; reading_text?: string; locator?: Record<string, unknown> };
type Context = { context_id: string; source_id: string; title: string; source_url: string; publisher_reading_url?: string | null; date: string | null; date_kind: string; event_date?: string | null; signature_date?: string | null; publication_date?: string | null; report_year?: number | null; date_basis?: Record<string, unknown> | null; boundary: string; verification_scope?: string; chapters?: Record<string, unknown>[]; question_paragraph_ids?: string[]; topic_answer_start_id?: string | null; context_text?: string; paragraphs: Paragraph[]; required_companion_context_ids?: string[] };
type Document = { id: string; sourceId: string; title: string; length: number; textCharacters: number; unitIds: string[]; complete: boolean; kind: string; shard: string };
type ArchiveIndex = { version: string; bundle_hash: string; scope: string; summary: Record<string, unknown>; documents: Document[]; postings: Record<string, number[]> };
const index = indexData as unknown as ArchiveIndex;
export const RETRIEVAL_VERSION = 'archive-phrase-coverage-3';
export const LIVE_EVIDENCE_VERSION = `${index.bundle_hash}:${RETRIEVAL_VERSION}`;
const MAX_CONTEXTS = 6, MAX_SOURCE_CHARACTERS = 42_000;
const STOP = new Set('a an the and or for of to in on with from by as at is are was were be been being it its this that these those i you your we our he his they their them do does did can could would should may might will what which how why when where who than then about into over have has had not no if but so all any some more most much many very also just really tell say said says think thoughts please explain according warren buffett charlie munger'.split(' '));
/** Matches the exporter's legacy _tokens; no editorial answer text is indexed. */
export function searchTokens(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length >= 2 && !STOP.has(w)).map(w => {
    if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  });
}
function searchPhrases(text:string):string[] {
  const terms=searchTokens(text).slice(0,24);
  return [...new Set(terms.slice(0,-1).map((term,i)=>`${term} ${terms[i+1]}`))];
}
// Search-language variants only: never supplied to the writer as evidence.
const CONCEPTS = [
  ['stock','stocks','share','shares','equity','equities'], ['business','businesses','company','companies','enterprise'],
  ['invest','investing','investment','investor','investors'], ['evaluate','evaluating','evaluation','assess','analyze','analysis'],
  ['value','valuation','valuing','worth'], ['great','good','successful','excellent'],
  ['understand','understanding','knowledge','competence'], ['profit','profits','earnings','earning'],
  ['durable','durability','lasting','sustainable'], ['moat','moats','competitive','advantage'],
  ['risk','risks','risky','danger'], ['borrow','borrowing','debt','leverage','leveraged'],
  ['buyback','buybacks','repurchase','repurchases','repurchasing'], ['honest','honesty','integrity','trustworthy'],
  ['manager','managers','management','executive'], ['diversify','diversified','diversification'],
  ['concentrate','concentrated','concentration'], ['inflation','inflationary','inflating'],
  ['patient','patience','waiting','wait'], ['emotional','emotion','temperament','discipline'],
];
const aliases = new Map<string, Set<string>>();
for (const concept of CONCEPTS) {
  const words = [...new Set(concept.flatMap(searchTokens))];
  for (const word of words) aliases.set(word, new Set([...(aliases.get(word) ?? []), ...words]));
}
/** Only explicit anaphora/elliptical requests inherit history, never all later turns. */
export function usesPreviousQuestion(question: string, previousQuestion?: string): boolean {
  if (!previousQuestion?.trim()) return false;
  const q = question.trim().toLowerCase();
  if (/^(?:new question|different topic|change (?:the )?topic|instead|unrelated)\b/.test(q)) return false;
  return /\b(?:that|those|this|these|it|them|their|he|his)\b/.test(q) || /^(?:and\s+)?(?:why|how so|can you (?:elaborate|give (?:me )?an example)|give (?:me )?an example|what do you mean)[?.!\s]*$/.test(q);
}
let byId: Map<string, Document> | undefined;
let averageLength = 0;
const shards = new Map<string, Record<string, Context>>();
function contextFor(doc: Document): Context {
  let data = shards.get(doc.shard);
  if (!data) {
    const load = (archiveShards as Record<string, () => unknown>)[doc.shard];
    if (!load) throw new Error('Missing original archive shard.');
    data = load() as Record<string, Context>;
    if (shards.size >= 3) shards.delete(shards.keys().next().value!);
    shards.set(doc.shard, data);
  }
  const ctx = data[doc.id];
  if (!ctx || ctx.context_id !== doc.id || ctx.source_id !== doc.sourceId) throw new Error('Archive source mapping mismatch.');
  return ctx;
}
export type RetrievalOptions = { queries: string[]; usePreviousQuestion: boolean };
export type RetrievalSelection = { contexts: Context[]; queryTerms: string[]; usedPreviousQuestion: boolean; scoredDocuments: number; corpusDocuments: number; sourceCharacters: number };
export function searchArchive(question: string, previousQuestion?: string, options?: RetrievalOptions): RetrievalSelection {
  if (typeof window !== 'undefined') throw new Error('Archive is server-only.');
  if (!question.trim() || question.length > 2000 || (previousQuestion?.length ?? 0) > 2000) throw new Error('Question is outside evidence bounds.');
  byId ??= new Map(index.documents.map(d => [d.id,d]));
  const documentsById=byId;
  averageLength ||= index.documents.reduce((s,d) => s+d.length,0)/index.documents.length;
  const usedPreviousQuestion = Boolean(previousQuestion && (options?.usePreviousQuestion ?? usesPreviousQuestion(question,previousQuestion)));
  if (options && (options.queries.length>4 || options.queries.some(q=>!q.trim() || q.length>160))) throw new Error('Search plan outside bounds.');
  const direct = [...new Set(searchTokens(question))].slice(0,24);
  const history = usedPreviousQuestion ? [...new Set(searchTokens(previousQuestion!))].filter(w => !direct.includes(w)).slice(0,16) : [];
  const originalGroups = [...direct.map(term => ({term,weight:1})), ...history.map(term => ({term,weight:.45}))];
  const queriesByTerms=new Map<string,{terms:string[];phrases:string[]}>();
  for(const q of options?.queries??[]){
    const terms=[...new Set(searchTokens(q))].slice(0,16).sort();
    const key=terms.join(' '),existing=queriesByTerms.get(key);
    // Retain phrase order without allowing reordered duplicate term sets to
    // vote twice in reciprocal-rank fusion or reserve two source contexts.
    queriesByTerms.set(key,{terms,phrases:[...new Set([...(existing?.phrases??[]),...searchPhrases(q)])].sort()});
  }
  const normalizedQueries=[...queriesByTerms.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,query])=>query).filter(query=>query.terms.length);
  if (options?.queries.length && !normalizedQueries.length) throw new Error('Search plan contains no searchable terms.');
  const variants = [{groups:originalGroups,phrases:[...searchPhrases(question),...(usedPreviousQuestion?searchPhrases(previousQuestion!):[])],weight: normalizedQueries.length ? 0.5 : 1,planned:false}, ...normalizedQueries.map(({terms,phrases})=>({groups:terms.map(term=>({term,weight:1})),phrases,weight:1,planned:true}))];
  const fused=new Map<number,number>();
  const plannedRankings: Document[][]=[];
  const variantRankings:{variant:typeof variants[number];candidates:{at:number;score:number}[]}[]=[];
  for (const variant of variants) {
    const {groups}=variant;
    if (!groups.length) continue;
    const scores = new Float64Array(index.documents.length), matches = new Uint8Array(index.documents.length);
    for (const {term,weight} of groups) {
      const best = new Map<number,number>();
      for (const word of new Set([term,...(aliases.get(term) ?? [])])) {
        const p = index.postings[word]; if (!p) continue;
        const idf = Math.log(1+(index.documents.length-p.length/2+.5)/(p.length/2+.5));
        for (let at=0;at<p.length;at+=2) {
          const doc=p[at],tf=p[at+1];
          const score = idf*tf*2.2/(tf+1.2*(.25+.75*index.documents[doc].length/averageLength))*weight*(word===term?1:.45);
          if (score>(best.get(doc) ?? 0)) best.set(doc,score);
        }
      }
      for (const [doc,score] of best) {scores[doc]+=score;matches[doc]++;}
    }
    const rankedVariant=index.documents.flatMap((document,at)=>{
      if (!document.complete || !scores[at] || matches[at]<Math.min(2,groups.length)) return [];
      return [{at,score:scores[at]*(.35+.65*matches[at]/groups.length)*(document.kind==='reviewed_context'?1.06:1)}];
    }).sort((a,b)=>b.score-a.score || index.documents[a.at].id.localeCompare(index.documents[b.at].id));
    variantRankings.push({variant,candidates:rankedVariant.slice(0,80)});
  }
  // Bag-of-words matches may scatter a concept's words across unrelated parts
  // of a long document. Rerank only the bounded lexical candidates using
  // ordered, normalized bigrams in original paragraphs, never titles/aliases.
  // Group reads by shard so a query does not repeatedly decompress each shard.
  const wantedPhrases=new Set(variants.flatMap(v=>v.phrases));
  const currentPhrases=new Set(searchPhrases(question));
  const phraseCounts=new Map<number,Map<string,number>>();
  const candidateIds=[...new Set(variantRankings.flatMap(r=>r.candidates.map(c=>c.at)))];
  candidateIds.sort((a,b)=>index.documents[a].shard.localeCompare(index.documents[b].shard)||a-b);
  if(wantedPhrases.size)for(const at of candidateIds){
    const counts=new Map<string,number>();
    for(const paragraph of contextFor(index.documents[at]).paragraphs){
      const terms=searchTokens(paragraph.reading_text??paragraph.text);
      for(let i=0;i<terms.length-1;i++){
        const phrase=`${terms[i]} ${terms[i+1]}`;
        if(wantedPhrases.has(phrase))counts.set(phrase,(counts.get(phrase)??0)+1);
      }
    }
    phraseCounts.set(at,counts);
  }
  for(const {variant,candidates} of variantRankings){
    const sources=new Set(candidates.map(c=>index.documents[c.at].sourceId));
    const phraseSources=new Map(variant.phrases.map(phrase=>[phrase,new Set(candidates.filter(c=>(phraseCounts.get(c.at)?.get(phrase)??0)>0).map(c=>index.documents[c.at].sourceId))]));
    for(const item of candidates)for(const [phrase,matchingSources] of phraseSources){
      const tf=phraseCounts.get(item.at)?.get(phrase)??0,df=matchingSources.size;
      // Repeated windows from one source are not independent phrase evidence.
      // Single-source coincidences get no bonus; the base score still applies.
      const weight=variant.planned||currentPhrases.has(phrase)?1:.45;
      if(tf&&df>=2)item.score+=2*Math.log(1+(sources.size-df+.5)/(df+.5))*tf/(tf+1)*weight;
    }
    candidates.sort((a,b)=>b.score-a.score||index.documents[a.at].id.localeCompare(index.documents[b.at].id));
    const eligible=candidates.filter(item=>item.score>=(candidates[0]?.score ?? 0)*.3);
    if (variant.planned) plannedRankings.push(eligible.map(item=>index.documents[item.at]));
    for (const [rank,item] of eligible.entries()) {
      const score=options?.queries.length ? variant.weight/(20+rank) : item.score;
      fused.set(item.at,(fused.get(item.at) ?? 0)+score);
    }
  }
  const ranked=[...fused].map(([at,score])=>({document:index.documents[at],score})).sort((a,b)=>b.score-a.score || a.document.id.localeCompare(b.document.id));
  const selected: Context[] = [], seenIds=new Set<string>(), seenUnits=new Set<string>(), sourceCounts=new Map<string,number>();
  let characters=0;
  const select=(document:Document):boolean=>{
    if (selected.length>=MAX_CONTEXTS || seenIds.has(document.id) || (sourceCounts.get(document.sourceId) ?? 0)>=2) return false;
    if (document.unitIds.length && document.unitIds.filter(id=>seenUnits.has(id)).length/document.unitIds.length>=.6) return false;
    const context=contextFor(document), group=[{document,context}], groupIds=new Set([document.id]);
    for (let cursor=0;cursor<group.length;cursor++) for (const id of group[cursor].context.required_companion_context_ids ?? []) {
      if (seenIds.has(id)||groupIds.has(id)) continue;
      const companion=documentsById.get(id);
      if (!companion?.complete) throw new Error('Required source qualification is missing.');
      groupIds.add(id);group.push({document:companion,context:contextFor(companion)});
    }
    const added=group.reduce((s,item)=>s+item.context.paragraphs.reduce((t,p)=>t+(p.reading_text ?? p.text).length,0),0);
    if (selected.length+group.length>MAX_CONTEXTS || characters+added>MAX_SOURCE_CHARACTERS) return false;
    for (const item of group) {
      selected.push(item.context);seenIds.add(item.document.id);item.document.unitIds.forEach(id=>seenUnits.add(id));
      sourceCounts.set(item.document.sourceId,(sourceCounts.get(item.document.sourceId) ?? 0)+1);
    }
    characters+=added;
    return true;
  };
  // Reserve a representative for each planned query before consensus ranking
  // fills the remaining space. A shared selected context can cover two queries.
  for (const candidates of plannedRankings) {
    for (const document of candidates) if (seenIds.has(document.id) || select(document)) break;
  }
  for (const {document,score} of ranked.slice(0,80)) {
    if (selected.length>=MAX_CONTEXTS) break;
    if (score<ranked[0].score*.30) continue;
    select(document);
  }
  return {contexts:selected,queryTerms:[...new Set(variants.flatMap(v=>v.groups.map(g=>g.term)))],usedPreviousQuestion,scoredDocuments:ranked.length,corpusDocuments:index.documents.length,sourceCharacters:characters};
}
export function retrieveContextIds(question:string,previousQuestion?:string,options?:RetrievalOptions) {return searchArchive(question,previousQuestion,options).contexts.map(c=>c.context_id);}
export function buildRetrievedEvidence(question:string,previousQuestion?:string,options?:RetrievalOptions):EvidencePrompt {
  const selection=searchArchive(question,previousQuestion,options);
  const referencesForValidation:EvidencePrompt['referencesForValidation']=Object.create(null),publicReferences:EvidencePrompt['publicReferences']=Object.create(null);
  let readingParagraphCharacters=0,originalContextCharacters=0,paragraphsCount=0;
  const sourceContexts=selection.contexts.map((context,contextIndex)=>{
    originalContextCharacters+=context.context_text?.length ?? context.paragraphs.reduce((s,p)=>s+p.text.length,0);
    const ids=new Set<string>();
    const paragraphs=context.paragraphs.map((p,at)=>{
      const key=`P${String(contextIndex+1).padStart(2,'0')}-${String(at+1).padStart(3,'0')}`,text=p.reading_text ?? p.text;
      if (!text.trim() || ids.has(p.id)) throw new Error('Invalid original source paragraph.');
      ids.add(p.id);readingParagraphCharacters+=text.length;paragraphsCount++;referencesForValidation[key]={text};
      const reference:PublicEvidenceReference={context_id:context.context_id,paragraph_ids:[p.id],label:`${context.title} · ${p.id}`,source_id:context.source_id,context_title:context.title,publisher_url:context.source_url,publisher_reading_url:context.publisher_reading_url ?? null,date:context.date,date_kind:context.date_kind,event_date:context.event_date ?? null,signature_date:context.signature_date ?? null,publication_date:context.publication_date ?? null,report_year:context.report_year ?? null,date_basis:context.date_basis ?? null,speakers:[p.speaker],paragraphs:[{id:p.id,...(p.unit_id?{unit_id:p.unit_id}:{}),speaker:p.speaker,...(p.speaker_basis?{speaker_basis:p.speaker_basis}:{}),...(p.locator?{locator:p.locator}:{})}]};
      publicReferences[key]=reference;return {id:p.id,paragraph_ref:key,speaker:p.speaker,text};
    });
    return {...context,paragraphs,context_text:undefined,chapters:context.chapters ?? [],question_paragraph_ids:context.question_paragraph_ids ?? [],topic_answer_start_id:context.topic_answer_start_id ?? null,publisher_url:context.source_url,event_date:context.event_date ?? null,signature_date:context.signature_date ?? null,publication_date:context.publication_date ?? null,report_year:context.report_year ?? null,verification_scope:context.verification_scope ?? null};
  });
  const data=JSON.stringify({question,evidence_scope:index.scope,bundle_hash:index.bundle_hash,source_contexts:sourceContexts});
  const messages:EvidencePrompt['messages']=[{role:'system',content:'Original evidence data for source-grounded answers.'},{role:'user',content:data}];
  return {messages,referencesForValidation,publicReferences,contextIds:selection.contexts.map(c=>c.context_id),bundleHash:index.bundle_hash,counts:{contexts:selection.contexts.length,paragraphs:paragraphsCount,references:paragraphsCount,originalContextCharacters,readingParagraphCharacters,systemWords:8,userCharacters:data.length,messageBytes:new TextEncoder().encode(JSON.stringify(messages)).byteLength}};
}
