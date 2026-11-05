/** Mechanical validation only. A pass is not semantic evidence verification. */
export type GeneratedAnswer = {
  title: string;
  lead: string;
  sections: [string, string][];
  prompt?: string;
  prompt_refs?: string[];
  reference_keys: string[];
  next?: null;
};
export type CitationText = { text: string };
export type GenerationValidationOptions = {
  /** Each text contains only the original cited paragraphs for that reference. */
  references: Record<string, CitationText>;
  maxWords?: number;
};
export type GenerationValidationResult = {
  answer: GeneratedAnswer;
  checks: {
    kind: "structure_citations_and_exact_quotes_only";
    referenceKeys: string[];
    exactQuotes: { text: string; referenceKey: string }[];
    normalizations: {
      kind: "quote_terminal_punctuation_moved";
      before: string;
      after: string;
      referenceKey: string;
    }[];
    semanticGroundingChecked: false;
  };
};
export class GenerationValidationError extends Error {
  constructor(public code: "json" | "structure" | "length" | "references" | "uncited_paragraph" | "quotation" | "unsupported_format") {
    super("The generated answer did not pass its required validation.");
    this.name = "GenerationValidationError";
  }
}

function fail(code: GenerationValidationError["code"]): never { throw new GenerationValidationError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim()) fail("structure");
  if (value.length > max) fail("length");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("unsupported_format");
  return value;
}
function keys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((key) =>
    typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(key)) || new Set(value).size !== value.length) fail("references");
  return value as string[];
}
function normalizedQuote(value: string) { return value.replace(/\s+/g, " ").trim(); }

function inlineKeys(value: string) {
  const found = [...value.matchAll(/\[\[([A-Za-z0-9][A-Za-z0-9._-]{0,79})\]\]/g)].map((match) => match[1]);
  if (/\[\[|\]\]/.test(value.replace(/\[\[([A-Za-z0-9][A-Za-z0-9._-]{0,79})\]\]/g, ""))) fail("references");
  return [...new Set(found)];
}

/**
 * Input is one JSON object with the UI answer fields, without a Markdown fence
 * or envelope. Every lead/body paragraph must have [[REF]] citations. A prompt
 * may use prompt_refs. Unused reference_keys are rejected. Quoted text must be
 * an exact (whitespace-normalized) substring of the paragraph's cited source.
 * If only its final period or comma prevents an exact match, that punctuation
 * is moved outside the closing quote in the returned text and recorded.
 * Titles and headings use plain unquoted text; links/HTML/blockquote/code are
 * not part of this rendering contract. Only a later semantic review may decide
 * whether a citation actually supports the surrounding claim.
 */
export function parseGeneratedAnswer(raw: string, options: GenerationValidationOptions): GenerationValidationResult {
  if (typeof raw !== "string" || raw.length > 60_000) fail("length");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("json"); }
  if (!object(parsed) || Object.keys(parsed).some((key) => ![
    "title", "lead", "sections", "prompt", "prompt_refs", "reference_keys", "next",
  ].includes(key))) fail("structure");
  const title = text(parsed.title, 180);
  let lead = parsed.lead === "" ? "" : text(parsed.lead, 4000);
  if (!Array.isArray(parsed.sections) || parsed.sections.length > 8) fail("structure");
  const sections = parsed.sections.map((section): [string, string] => {
    if (!Array.isArray(section) || section.length !== 2) fail("structure");
    return [text(section[0], 160), text(section[1], 8000)];
  });
  if (!lead && !sections.length) fail("structure");
  if (new Set(sections.map(([heading]) => heading.trim().toLowerCase())).size !== sections.length) fail("structure");
  const referenceKeys = keys(parsed.reference_keys);
  if (!referenceKeys.length || referenceKeys.some((key) => !Object.prototype.hasOwnProperty.call(options.references, key) ||
    typeof options.references[key]?.text !== "string" || !options.references[key].text.trim())) fail("references");
  let prompt = parsed.prompt === undefined ? undefined : text(parsed.prompt, 2500);
  const promptRefs = parsed.prompt_refs === undefined ? undefined : keys(parsed.prompt_refs);
  if (prompt && (!promptRefs || !promptRefs.length)) fail("references");
  if (!prompt && promptRefs?.length) fail("structure");
  if (promptRefs?.some((key) => !referenceKeys.includes(key))) fail("references");
  if (parsed.next !== undefined && parsed.next !== null) fail("structure");
  const plainHeadings = [title, ...sections.map(([heading]) => heading)];
  if (plainHeadings.some((value) => /["“”‘]|\[\[|\]\]|\n|`|(^|[\s(])'/.test(value))) fail("unsupported_format");

  const allText = [title, lead, ...sections.flat(), ...(prompt ? [prompt] : [])].join("\n");
  const maximumWords = options.maxWords ?? 1200;
  if (!Number.isSafeInteger(maximumWords) || maximumWords < 100 || maximumWords > 2000 ||
      allText.trim().split(/\s+/).length > maximumWords) fail("length");
  if (/https?:\/\/|www\.|<[^>]+>|\[[^\]]+\]\([^)]*\)|(^|\n)\s*>|`/i.test(allText)) fail("unsupported_format");

  const used = new Set<string>();
  const exactQuotes: { text: string; referenceKey: string }[] = [];
  const normalizations: GenerationValidationResult["checks"]["normalizations"] = [];
  const validateParagraph = (paragraph: string, fallbackKeys: string[] = []) => {
    const citations = inlineKeys(paragraph);
    if (!citations.length && !fallbackKeys.length) fail("uncited_paragraph");
    const allowed = [...new Set([...citations, ...fallbackKeys])];
    if (allowed.some((key) => !referenceKeys.includes(key))) fail("references");
    for (const key of allowed) used.add(key);
    const quotes: { text: string; start: number; end: number }[] = [];
    let unquoted = paragraph.replace(/"([^"\n]+)"|“([^”\n]+)”|‘([^’\n]+)’/g, (match, straight, curly, single, offset) => {
      quotes.push({ text: straight ?? curly ?? single, start: offset, end: offset + match.length });
      // Preserve offsets while masking these quotes before finding straight
      // single-quoted text; apostrophes inside a matched quote are not rescanned.
      return " ".repeat(match.length);
    });
    // Single straight quotes are recognized only at word boundaries, so an
    // ordinary apostrophe in owner's or Buffett's is not treated as a quote.
    unquoted = unquoted.replace(/(^|[\s(])'([^'\n]+)'(?=[\s.,;:!?)]|$)/g, (match, prefix, quotation, offset) => {
      quotes.push({ text: quotation, start: offset + prefix.length, end: offset + match.length });
      return prefix + " ".repeat(match.length - prefix.length);
    });
    if (/["“”‘]|(^|[\s(])'/.test(unquoted)) fail("quotation");
    let result = "";
    let cursor = 0;
    for (const quotation of quotes.sort((a, b) => a.start - b.start)) {
      const normalized = normalizedQuote(quotation.text);
      if (!normalized) fail("quotation");
      const exactSource = (candidateText: string) => allowed.find((candidate) =>
        normalizedQuote(options.references[candidate].text).includes(candidateText));
      let key = exactSource(normalized);
      let exactText = quotation.text;
      const before = paragraph.slice(quotation.start, quotation.end);
      let after = before;
      if (!key && /[.,]$/.test(quotation.text)) {
        const withoutPunctuation = quotation.text.slice(0, -1);
        const normalizedWords = normalizedQuote(withoutPunctuation);
        if (normalizedWords) key = exactSource(normalizedWords);
        if (key) {
          exactText = withoutPunctuation;
          after = before[0] + withoutPunctuation + before[before.length - 1] + quotation.text.slice(-1);
          normalizations.push({ kind: "quote_terminal_punctuation_moved", before, after, referenceKey: key });
        }
      }
      if (!key) fail("quotation");
      exactQuotes.push({ text: exactText, referenceKey: key });
      result += paragraph.slice(cursor, quotation.start) + after;
      cursor = quotation.end;
    }
    return result + paragraph.slice(cursor);
  };
  const validateBody = (value: string, fallbackKeys: string[] = []) => value.split(/(\n\s*\n)/)
    .map((part, index) => index % 2 || !part.trim() ? part : validateParagraph(part, fallbackKeys)).join("");
  lead = validateBody(lead);
  for (const section of sections) section[1] = validateBody(section[1]);
  if (prompt) prompt = validateBody(prompt, promptRefs);
  if (referenceKeys.some((key) => !used.has(key))) fail("references");

  return {
    answer: { title, lead, sections, reference_keys: referenceKeys,
      ...(prompt ? { prompt, prompt_refs: promptRefs } : {}), ...(parsed.next === null ? { next: null } : {}) },
    checks: { kind: "structure_citations_and_exact_quotes_only", referenceKeys: [...used], exactQuotes, normalizations, semanticGroundingChecked: false },
  };
}
