import content from "../content/public-content.json";

export const contentVersion = content.bundle_hash;
type Question = typeof content.questions[number];

function normalize(text: string) {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

export function findCuratedQuestion(question: string, slug?: string) {
  const normalized = normalize(question);
  return content.questions.find((item) => (!slug || item.slug === slug) &&
    [item.title, item.short].some((text) => normalize(text) === normalized)) ?? null;
}

export function curatedAnswer(question: Question) {
  const keys = new Set([...question.reference_keys, ...question.prompt_refs]);
  const references = Object.fromEntries(Object.entries(content.references).filter(([key]) => keys.has(key)));
  return {
    answer: {
      title: question.title,
      lead: question.lead,
      sections: question.sections,
      prompt: question.prompt,
      prompt_refs: question.prompt_refs,
      reference_keys: question.reference_keys,
      next: question.next,
    },
    references,
  };
}

export function relatedReading(question: string) {
  // Ranking only changes the reading suggestions. It never produces an answer
  // to an unmatched question or rewrites the reviewed editorial content.
  const words = new Set(normalize(question).match(/[a-z]{4,}/g) ?? []);
  const ranked = content.questions.map((item, index) => {
    const available = new Set(normalize(`${item.title} ${item.short} ${item.deck}`).match(/[a-z]{4,}/g) ?? []);
    const score = [...words].filter((word) => available.has(word)).length;
    return { item, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, 3).map(({ item }) => ({ slug: item.slug, title: item.title, short: item.short }));
}
