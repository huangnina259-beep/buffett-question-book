export type QuotePunctuationNormalization = {
  kind: "quote_terminal_punctuation_moved";
  before: string;
  after: string;
  referenceKey: string;
};
export const MAX_QUOTE_PUNCTUATION_NORMALIZATIONS = 128;
export const MAX_QUOTE_PUNCTUATION_TEXT_LENGTH = 8002;

export type PilotSource = {
  label: string; context_title: string; publisher_url: string;
  publisher_reading_url?: string | null; date?: string | null; date_kind?: string;
  report_year?: number | null; speakers?: (string | null)[]; paragraph_ids?: string[];
  paragraphs?: { id: string; speaker?: string | null; locator?: Record<string, unknown>; [key: string]: unknown }[];
  excerpt?: string;
  [key: string]: unknown;
};
export type PilotAnswer = {
  title: string;
  lead: string;
  sections: string[][];
  prompt?: string;
  prompt_refs?: string[];
  reference_keys: string[];
  next?: string | null;
};
export type PilotResult = {
  id: string;
  kind: "curated" | "generated" | "suggestions" | "unavailable" | "question_received" | "processing";
  recorded?: true;
  question: string;
  answer?: PilotAnswer;
  references?: Record<string, PilotSource>;
  message?: string;
  suggestions?: { slug: string; title: string; short: string }[];
  elapsedMs: number;
  retryAfterMs?: number;
  generation?: {
    label: string;
    checks: "structure_citations_and_exact_quotes_only";
    humanReviewed: false;
    scope: string;
    cached: boolean;
    quotePunctuationNormalizations?: QuotePunctuationNormalization[];
  };
};
export type FeedbackReason = "not_covered" | "too_general" | "unclear" | "sources" | "too_slow" | "other";
export type PilotFeedback = { helpful: boolean | null; reason: FeedbackReason | null; comment: string };
export type PilotHistory = { results: PilotResult[]; feedback: Record<string, PilotFeedback> };
