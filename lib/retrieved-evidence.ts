/** Server-only original evidence; never import this module into client code. */
import packetData from "./content/live-evidence-packets.json";
import indexData from "./content/live-retrieval-index.json";
import type { EvidencePrompt, PublicEvidenceReference } from "./evidence-prompt";

type Paragraph = { id: string; unit_id?: string; speaker: string | null; speaker_basis?: string; text: string; reading_text?: string; locator?: Record<string, unknown> };
type Context = {
  context_id: string; source_id: string; title: string; source_url: string; publisher_reading_url?: string | null;
  date: string | null; date_kind: string; event_date?: string | null; signature_date?: string | null;
  publication_date?: string | null; report_year?: number | null; date_basis?: Record<string, unknown> | null;
  boundary: string; verification_scope?: string; chapters?: Record<string, unknown>[];
  question_paragraph_ids?: string[]; topic_answer_start_id?: string; context_text: string; paragraphs: Paragraph[];
};
type RetrievalIndex = {
  version: string; bundle_hash: string;
  topics: { id: string; terms: string[]; context_ids: string[]; required_context_ids?: string[]; priority?: number }[];
  broad_evaluation: { terms: string[]; context_ids: string[] };
  max_contexts: number; max_source_characters: number;
};
const packet = packetData as unknown as { bundle_hash: string; scope: string; contexts: Context[] };
const index = indexData as RetrievalIndex;
export const LIVE_EVIDENCE_VERSION = packet.bundle_hash;
function normalize(text: string) { return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function termMatch(text: string, term: string) { return (` ${text} `).includes(` ${normalize(term)} `); }

export function retrieveContextIds(question: string, previousQuestion?: string) {
  if (packet.bundle_hash !== index.bundle_hash) throw new Error("Retrieval evidence version mismatch.");
  const query = normalize(question);
  const preceding = normalize(previousQuestion ?? "");
  const directTopic = index.topics.some((topic) => topic.terms.some((term) => termMatch(query, term)));
  const broad = index.broad_evaluation.terms.some((term) => termMatch(query, term)) ||
    (!directTopic && index.broad_evaluation.terms.some((term) => termMatch(preceding, term)));
  const ranked = index.topics.map((topic, order) => ({ topic, order,
    score: topic.terms.reduce((score, term) => score + (termMatch(query, term) ? 2 : termMatch(preceding, term) ? 1 : 0), 0),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || (b.topic.priority ?? 0) - (a.topic.priority ?? 0) || a.order - b.order);
  const known = new Map(packet.contexts.map((context) => [context.context_id, context]));
  const selected = new Set<string>();
  let characters = 0;
  const appendGroup = (ids: string[]) => {
    const added = [...new Set(ids)].filter((id) => !selected.has(id));
    if (added.some((id) => !known.has(id))) throw new Error("Unknown retrieval context.");
    const addedSize = added.reduce((size, id) => size + known.get(id)!.paragraphs.reduce((sum, p) => sum + (p.reading_text ?? p.text).length, 0), 0);
    if (selected.size + added.length > Math.min(8, index.max_contexts) || characters + addedSize > Math.min(60_000, index.max_source_characters)) return;
    added.forEach((id) => selected.add(id)); characters += addedSize;
  };
  if (broad) appendGroup(index.broad_evaluation.context_ids);
  for (const { topic } of ranked) appendGroup([...(topic.required_context_ids ?? []), ...topic.context_ids]);
  return packet.contexts.filter((context) => selected.has(context.context_id)).map((context) => context.context_id);
}

export function buildRetrievedEvidence(question: string, previousQuestion?: string): EvidencePrompt {
  if (typeof window !== "undefined") throw new Error("Evidence is server-only.");
  if (!question.trim() || question.length > 2000 || (previousQuestion?.length ?? 0) > 2000) throw new Error("Question is outside evidence bounds.");
  const selected = new Set(retrieveContextIds(question, previousQuestion));
  const referencesForValidation: EvidencePrompt["referencesForValidation"] = Object.create(null);
  const publicReferences: EvidencePrompt["publicReferences"] = Object.create(null);
  let readingParagraphCharacters = 0;
  let originalContextCharacters = 0;
  let paragraphsCount = 0;
  const sourceContexts = packet.contexts.flatMap((context, contextIndex) => {
    if (!selected.has(context.context_id)) return [];
    originalContextCharacters += context.context_text.length;
    const paragraphs = context.paragraphs.map((paragraph, paragraphIndex) => {
      const key = `P${String(contextIndex + 1).padStart(2, "0")}-${String(paragraphIndex + 1).padStart(3, "0")}`;
      const text = paragraph.reading_text ?? paragraph.text;
      if (!text.trim()) throw new Error("Empty source paragraph.");
      readingParagraphCharacters += text.length; paragraphsCount++;
      referencesForValidation[key] = { text };
      const reference: PublicEvidenceReference = {
        context_id: context.context_id, paragraph_ids: [paragraph.id], label: `${context.title} · ${paragraph.id}`,
        source_id: context.source_id, context_title: context.title, publisher_url: context.source_url,
        publisher_reading_url: context.publisher_reading_url ?? null, date: context.date, date_kind: context.date_kind,
        event_date: context.event_date ?? null, signature_date: context.signature_date ?? null,
        publication_date: context.publication_date ?? null, report_year: context.report_year ?? null, date_basis: context.date_basis ?? null,
        speakers: [paragraph.speaker], paragraphs: [{ id: paragraph.id, ...(paragraph.unit_id ? { unit_id: paragraph.unit_id } : {}), speaker: paragraph.speaker,
          ...(paragraph.speaker_basis ? { speaker_basis: paragraph.speaker_basis } : {}), ...(paragraph.locator ? { locator: paragraph.locator } : {}) }],
      };
      publicReferences[key] = reference;
      return { id: paragraph.id, paragraph_ref: key, speaker: paragraph.speaker, text };
    });
    return [{ ...context, paragraphs, context_text: undefined, chapters: context.chapters ?? [], question_paragraph_ids: context.question_paragraph_ids ?? [],
      topic_answer_start_id: context.topic_answer_start_id ?? null, publisher_url: context.source_url,
      event_date: context.event_date ?? null, signature_date: context.signature_date ?? null, publication_date: context.publication_date ?? null,
      report_year: context.report_year ?? null, verification_scope: context.verification_scope ?? null }];
  });
  const data = JSON.stringify({ question, evidence_scope: packet.scope, bundle_hash: packet.bundle_hash, source_contexts: sourceContexts });
  const messages: EvidencePrompt["messages"] = [{ role: "system", content: "Original evidence data for source-grounded answers." }, { role: "user", content: data }];
  return { messages, referencesForValidation, publicReferences, contextIds: [...selected], bundleHash: packet.bundle_hash,
    counts: { contexts: selected.size, paragraphs: paragraphsCount, references: paragraphsCount, originalContextCharacters, readingParagraphCharacters,
      systemWords: 8, userCharacters: data.length, messageBytes: new TextEncoder().encode(JSON.stringify(messages)).byteLength } };
}
