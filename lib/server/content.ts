import content from "../content/public-content.json";

export const contentVersion = content.content_hash;
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
  const words = meaningfulWords(question);
  const ranked = content.questions.map((item, index) => {
    const available = readingWords[index];
    const score = [...words].reduce((total, word) => {
      const frequency = documentFrequency.get(word) ?? 0;
      // Common topic language is too weak to turn an arbitrary question into a
      // useful recommendation. A match must distinguish an actual passage.
      return total + (available.has(word) && frequency < 4 ? 1 / frequency : 0);
    }, 0);
    return { item, index, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, 3).map(({ item }) => ({ slug: item.slug, title: item.title, short: item.short }));
}

const stopWords = new Set(`about after again also always answer answers before being buffett could does doing each either example from give have help here into just know like make many might more most much must need only other over question questions really said says should some something than that their them then there these they thing think this those through today under very want well were what when where whether which while will with without would your`.split(" "));
function meaningfulWords(value: string) {
  return new Set((normalize(value).replace(/\[\[[^\]]+\]\]/g, " ").match(/[a-z]{4,}/g) ?? [])
    .filter((word) => !stopWords.has(word)));
}
const readingWords = content.questions.map((item) => meaningfulWords(
  `${item.title} ${item.short} ${item.deck} ${item.lead} ${item.sections.flat().join(" ")}`,
));
const documentFrequency = new Map<string, number>();
for (const words of readingWords) for (const word of words) {
  documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
}
