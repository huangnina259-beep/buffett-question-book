import type content from "./content/public-content.json";

export type PilotSource = typeof content.references[keyof typeof content.references];
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
  kind: "curated" | "generated" | "suggestions" | "unavailable" | "question_received";
  recorded?: true;
  question: string;
  answer?: PilotAnswer;
  references?: Record<string, PilotSource>;
  message?: string;
  suggestions?: { slug: string; title: string; short: string }[];
  elapsedMs: number;
};
export type FeedbackReason = "not_covered" | "too_general" | "unclear" | "sources" | "too_slow" | "other";
export type PilotFeedback = { helpful: boolean | null; reason: FeedbackReason | null; comment: string };
export type PilotHistory = { results: PilotResult[]; feedback: Record<string, PilotFeedback> };
