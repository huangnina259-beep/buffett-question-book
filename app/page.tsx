"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import content from "../lib/content/public-content.json";

type Source = {
  label: string;
  context_title: string;
  publisher_url: string;
  publisher_reading_url?: string | null;
  date?: string | null;
  date_kind?: string;
  report_year?: number | null;
  speakers?: string[];
  paragraph_ids?: string[];
  paragraphs?: { id: string; speaker?: string; locator?: Record<string, unknown> }[];
};
type Answer = {
  title: string;
  lead: string;
  sections: [string, string][];
  prompt?: string;
  prompt_refs?: string[];
  reference_keys: string[];
  next?: string | null;
};
type Result = {
  id: string;
  kind: "curated" | "generated" | "suggestions" | "unavailable" | "question_received";
  recorded?: boolean;
  question: string;
  answer?: Answer;
  references?: Record<string, Source>;
  message?: string;
  suggestions?: { slug: string; title: string; short: string }[];
  elapsedMs: number;
};
type QuestionPayload = { question: string; curatedSlug?: string; previousAnswerId?: string };
type Session = { csrfToken: string; generationEnabled: boolean; feedbackEnabled: boolean; contentVersion: string };
type Reason = "not_covered" | "too_general" | "unclear" | "sources" | "too_slow" | "other" | "";
type Feedback = { helpful: boolean | null; reason: Reason; comment: string; status: "idle" | "saving" | "saved" | "error"; error?: string };
const emptyFeedback: Feedback = { helpful: null, reason: "", comment: "", status: "idle" };
const initialQuestions = [content.questions[0], content.questions[1], content.questions[3]];
const officialSources = content.references as Record<string, Source>;

function officialLink(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["www.berkshirehathaway.com", "berkshirehathaway.com", "buffett.cnbc.com", "www.cnbc.com", "cnbc.com"].includes(url.hostname)) return url.href;
  } catch { /* An invalid source URL is shown without a link. */ }
  return null;
}

function SourceLocator({ locator }: { locator: Record<string, unknown> }) {
  const fields: [string, string][] = [
    ["physical_pdf_page", "PDF page"],
    ["printed_page", "Printed page"],
    ["paragraph_on_page", "Paragraph on page"],
    ["chapter_number", "Chapter"],
    ["paragraph_index", "Transcript paragraph"],
    ["paragraph", "HTML paragraph"],
    ["html_line_start", "HTML line start"],
    ["html_line_end", "HTML line end"],
  ];
  const position = fields
    .filter(([key]) => locator[key] !== null && locator[key] !== undefined)
    .map(([key, label]) => `${label}: ${String(locator[key])}`)
    .join(" · ");
  const hasTimestamp = typeof locator.timestamp_seconds === "number" && Number.isFinite(locator.timestamp_seconds);
  const status = typeof locator.timestamp_status === "string" ? locator.timestamp_status : null;
  const timingNote = status === "publisher_metadata_not_audio_verified"
    ? "Timing status: publisher metadata; not verified against audio."
    : status
      ? `Timing status: ${status.replaceAll("_", " ")}.`
      : hasTimestamp
        ? "Timing verification status is not supplied."
        : null;
  return <>
    {position && <span>{position}</span>}
    {hasTimestamp && <span>Publisher timestamp: {String(locator.timestamp_seconds)} seconds</span>}
    {timingNote && <span>{timingNote}</span>}
    {locator.chapter_number !== undefined && <span>{hasTimestamp
      ? "The publisher link opens the meeting page, not a verified jump to this paragraph."
      : locator.paragraph_index !== undefined
        ? "Transcript paragraph location is available, but no paragraph timestamp is supplied."
        : "Chapter-level location only; no paragraph timestamp is supplied."}</span>}
  </>;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.name !== "AbortError" ? error.message : fallback;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Result[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [requestError, setRequestError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [source, setSource] = useState<{ ref: Source; number: number; key: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const exploreRef = useRef<HTMLDetailsElement>(null);
  const retryRef = useRef<{ signature: string; requestId: string; payload: QuestionPayload } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mutationRevisionRef = useRef(0);
  const feedbackSavesRef = useRef(0);
  const selected = entries.find((entry) => entry.id === selectedId);
  const conversation = busy || Boolean(selected);
  const currentFeedback = selected ? feedback[selected.id] || { ...emptyFeedback, reason: selected.answer ? "" as Reason : "not_covered" as Reason } : emptyFeedback;

  async function connect(signal?: AbortSignal) {
    setSessionError("");
    try {
      const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("The service could not connect. Please try again.");
      const data: Session = await response.json();
      if (!data.csrfToken) throw new Error("The service did not return a valid session. Please try again.");
      await loadHistory(data, signal);
      setSession(data);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setSessionError(errorMessage(error, "The service could not connect. Please try again."));
    }
  }

  async function loadHistory(activeSession: Session, signal?: AbortSignal) {
    const startedRevision = mutationRevisionRef.current;
    setHistoryError("");
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/questions", {
        credentials: "same-origin", cache: "no-store", signal,
        headers: { "X-CSRF-Token": activeSession.csrfToken },
      });
      if (!response.ok) throw new Error("Your recent questions could not be loaded.");
      const data = await response.json() as { results?: Result[]; feedback?: Record<string, { helpful: boolean | null; reason: Reason | null; comment: string }> };
      if (!Array.isArray(data.results)) throw new Error("Your recent questions could not be loaded.");
      // A history read must not replace a question or feedback changed after it began.
      // Also defer reads that complete while a write is still awaiting confirmation.
      if (mutationRevisionRef.current !== startedRevision || requestRef.current || feedbackSavesRef.current > 0) {
        setHistoryError("Your current work has been kept. Try loading again to refresh older questions.");
        return;
      }
      setEntries(data.results.slice(-20));
      const restored: Record<string, Feedback> = {};
      for (const [id, item] of Object.entries(data.feedback || {})) {
        restored[id] = { helpful: item.helpful, reason: item.reason || "", comment: item.comment, status: "saved" };
      }
      setFeedback((current) => ({ ...restored, ...current }));
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setHistoryError("Your recent questions could not be loaded. You can still submit a question.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function changeQuestion(value: string) {
    if (value.trim() !== question.trim()) { retryRef.current = null; setCanRetry(false); }
    setQuestion(value);
  }

  function exploreQuestions() {
    closeMenus();
    if (exploreRef.current) {
      exploreRef.current.open = true;
      exploreRef.current.querySelector("summary")?.focus();
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void connect(controller.signal);
    return () => { controller.abort(); requestRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (source && dialog && !dialog.open) dialog.showModal();
  }, [source]);

  function closeMenus(except?: HTMLDetailsElement) {
    headerRef.current?.querySelectorAll("details[open]").forEach((menu) => {
      if (menu !== except) menu.removeAttribute("open");
    });
  }

  function newQuestion() {
    closeMenus();
    setSelectedId(null);
    retryRef.current = null;
    setCanRetry(false);
    setQuestion("");
    setRequestError("");
    setAnnouncement("New question. Previous answer context has been cleared.");
    inputRef.current?.focus();
  }

  async function ask(text: string, curatedSlug?: string) {
    const cleaned = text.trim();
    if (!session || busy || requestRef.current || cleaned.length < 3 || cleaned.length > 2000) return;
    mutationRevisionRef.current += 1;
    closeMenus();
    setQuestion(cleaned);
    setPendingQuestion(cleaned);
    setRequestError("");
    setCanRetry(false);
    setBusy(true);
    setElapsed(0);
    const payload = { question: cleaned, ...(curatedSlug ? { curatedSlug } : {}), ...(!curatedSlug && selected?.answer ? { previousAnswerId: selected.id } : {}) };
    const signature = JSON.stringify(payload);
    if (retryRef.current?.signature !== signature) retryRef.current = { signature, requestId: crypto.randomUUID(), payload };
    const requestId = retryRef.current.requestId;
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/questions", {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ ...payload, requestId }),
      });
      const data = await response.json() as Result & { error?: string };
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "The request could not be completed. Your question is still here; please try again.");
      if (!data.id || !["curated", "generated", "suggestions", "unavailable", "question_received"].includes(data.kind)) throw new Error("The response was incomplete. Please try again.");
      if (data.kind === "question_received" && data.recorded !== true) throw new Error("We could not confirm that your question was saved. Please try again.");
      const result = data as Result;
      mutationRevisionRef.current += 1;
      setEntries((previous) => [...previous.filter((item) => item.id !== result.id), result].slice(-20));
      setSelectedId(result.id);
      if (result.answer || result.recorded) setQuestion("");
      retryRef.current = null;
      setAnnouncement(result.answer ? "Your reviewed answer is ready. Citations open the source details." : result.recorded ? "Question saved to help choose future topics. No individual reply is promised." : "No reviewed answer covers this question yet.");
      window.setTimeout(() => answerRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 50);
    } catch (error) {
      setCanRetry(true);
      setRequestError(errorMessage(error, "We could not confirm the result in time. Your draft has been kept; retrying the unchanged question will not create a duplicate."));
      setAnnouncement("The question could not be completed. Your draft has been kept.");
    } finally {
      window.clearTimeout(timer);
      requestRef.current = null;
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  function choose(slug: string) {
    const chosen = content.questions.find((item) => item.slug === slug);
    if (chosen) void ask(chosen.title, slug);
  }

  function updateFeedback(patch: Partial<Feedback>) {
    if (!selected) return;
    mutationRevisionRef.current += 1;
    setFeedback((previous) => ({ ...previous, [selected.id]: { ...(previous[selected.id] || currentFeedback), ...patch, status: "idle" } }));
  }

  async function saveFeedback(helpful: boolean | null = currentFeedback.helpful) {
    if (!session || !selected || !session.feedbackEnabled || currentFeedback.status === "saving") return;
    const id = selected.id;
    mutationRevisionRef.current += 1;
    feedbackSavesRef.current += 1;
    const payload = { ...currentFeedback, helpful };
    setFeedback((previous) => ({ ...previous, [id]: { ...payload, status: "saving" } }));
    try {
      const response = await fetch("/api/feedback", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ answerId: id, helpful, reason: payload.reason || null, comment: payload.comment }),
      });
      const data = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || data.saved !== true) throw new Error(typeof data.error === "string" ? data.error : "Feedback could not be saved. Please try again.");
      mutationRevisionRef.current += 1;
      setFeedback((previous) => ({ ...previous, [id]: { ...payload, status: "saved" } }));
    } catch (error) {
      mutationRevisionRef.current += 1;
      setFeedback((previous) => ({ ...previous, [id]: { ...payload, status: "error", error: errorMessage(error, "Feedback could not be saved. Please try again.") } }));
    } finally {
      feedbackSavesRef.current -= 1;
    }
  }

  function openSource(key: string) {
    if (!selected?.answer) return;
    const ref = selected.references?.[key] || officialSources[key];
    if (ref) setSource({ key, ref, number: selected.answer.reference_keys.indexOf(key) + 1 });
  }

  function citation(key: string, reactKey: string) {
    const number = selected?.answer?.reference_keys.indexOf(key) ?? -1;
    const ref = selected?.references?.[key] || officialSources[key];
    return ref && number >= 0 ? <button className="citation" key={reactKey} type="button" onClick={() => openSource(key)} aria-label={`Source ${number + 1}: ${ref.label}`}>{number + 1}</button> : <span className="missing-source" key={reactKey}>[source unavailable]</span>;
  }

  function richText(text: string): ReactNode {
    return text.split(/(\[\[[A-Za-z0-9_-]+\]\])/g).map((part, index) => {
      const match = part.match(/^\[\[([A-Za-z0-9_-]+)\]\]$/);
      return match ? citation(match[1], `${match[1]}-${index}`) : <Fragment key={index}>{part}</Fragment>;
    });
  }

  function paragraphs(text: string) {
    return text.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{richText(paragraph)}</p>);
  }

  const sourceUrl = officialLink(source?.ref.publisher_reading_url) || officialLink(source?.ref.publisher_url);
  const nextQuestion = selected?.answer?.next ? content.questions.find((item) => item.slug === selected.answer?.next) : null;

  return (
    <>
      <a className="skip-link" href="#question">Skip to your question</a>
      <div className={`page-shell${conversation ? " conversation-mode" : ""}`}>
        <header className="site-header" ref={headerRef} onKeyDown={(event) => {
          if (event.key === "Escape") {
            const menu = (event.target as HTMLElement).closest("details");
            closeMenus();
            menu?.querySelector("summary")?.focus();
          }
        }}>
          <button className="brand" type="button" onClick={newQuestion} disabled={busy} aria-label="Buffett Question Book — new question"><span className="brand-mark" aria-hidden="true">B</span><span>Buffett Question Book</span></button>
          <nav aria-label="Site navigation">
            {(entries.length > 0 || historyLoading || historyError) && <details className="header-menu" onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>Your questions</summary>
              <div className="menu-panel history-panel"><h2 className="sr-only">Your questions</h2><ol>{[...entries].reverse().map((entry) => <li key={entry.id}><button type="button" disabled={busy} aria-current={selectedId === entry.id ? "true" : undefined} onClick={() => { closeMenus(); retryRef.current = null; setCanRetry(false); setSelectedId(entry.id); setQuestion(""); setRequestError(""); }}>{entry.question}</button></li>)}</ol><p className="small-note">Your last 20 questions on this browser. Reloading returns to the homepage; your recent questions remain here while this browser session is valid.</p>{historyLoading && <p className="small-note" role="status">Loading recent questions…</p>}{historyError && <><p className="small-note" role="alert">{historyError}</p><button className="text-button" type="button" disabled={!session || busy || historyLoading} onClick={() => { if (session) void loadHistory(session); }}>Try loading again</button></>}</div>
            </details>}
            <details className="header-menu" ref={exploreRef} onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>Explore</summary>
              <div className="menu-panel explore-panel"><p className="eyebrow">Circle of competence</p><p className="menu-description">Six edited answers, ready to read.</p><ol>{content.questions.map((item) => <li key={item.slug}><button type="button" disabled={!session || busy} onClick={() => choose(item.slug)}><span className="question-number">{item.number}</span><span>{item.title}</span></button></li>)}</ol></div>
            </details>
            <details className="header-menu" onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>About</summary>
              <div className="menu-panel about-panel"><h2>Close to the sources.</h2><p>A question book about Buffett and Munger, beginning with the circle of competence. This pilot has six reviewed answers from selected primary contexts—not everything they have said.</p><h3>Read, or help choose the next topic</h3><p><strong>Edited answers</strong> are prepared explanations with a scoped independent agent review. They are editorial syntheses, not Buffett’s own answer to your question. Source links let you check the original context.</p><p>Choose a reviewed question to read its answer immediately. If your own question is not covered, we save it to help choose future coverage. This pilot does not generate a new answer or promise an individual reply.</p><p>Answers are in English. There is no current-market feed or assessment of an investment’s suitability today.</p><h3>Your questions and feedback</h3><p>Submitted questions, responses and feedback are stored for this pilot. Please leave out personal or confidential information. No contact details are requested, and submissions are not sent to a model provider.</p><p>Your last 20 questions are available on this browser while its session remains valid. A session expires 30 days after it is created; activity does not extend it. Reloading returns to the homepage and preserves access to recent questions. Clearing cookies or using another browser does not restore this history.</p><p>Expired sessions and their question and feedback records are removed in small batches when new sessions are created. Cleanup is opportunistic, so records may remain after expiry until cleanup runs. This is not a permanent question archive.</p></div>
            </details>
          </nav>
        </header>

        <main>
          {!conversation && <section className="hero" aria-labelledby="page-title"><p className="eyebrow">A question book, rooted in the originals</p><h1 id="page-title">What would you like<br className="hero-break" /> to understand?</h1><p>Explore Buffett and Munger’s ideas, with the sources in reach.</p></section>}
          <p className="pilot-note">Read six reviewed answers now. New questions help us choose what to cover next.</p>
          <section className="composer" aria-label="Submit a question">
            {conversation && <div className="composer-heading"><h2>{selected?.answer ? "Suggest a follow-up question" : "Your question"}</h2><button type="button" className="text-button" onClick={newQuestion} disabled={busy}>New question</button></div>}
            {selected?.answer && <p className="context-note">Question relates to: <span>{selected.question}</span></p>}
            <form onSubmit={submit}>
              <label className="sr-only" htmlFor="question">Your question</label>
              <textarea ref={inputRef} id="question" value={question} onChange={(event) => changeQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (question.trim().length >= 3) void ask(question); } }} rows={2} minLength={3} maxLength={2000} required disabled={busy} placeholder={selected?.answer ? "What should a future answer explain in more depth?" : "Find a reviewed answer, or suggest a question…"} aria-describedby="privacy-note question-help" />
              <div className="composer-actions"><p id="question-help"><span className="keyboard-hint">⌘ / Ctrl + Enter</span><span className="sr-only"> to submit. Enter 3 to 2,000 characters.</span></p><button type="submit" className="primary-button" disabled={!session || busy || question.trim().length < 3}>{busy ? "Checking…" : <>Find an answer <span aria-hidden="true">↑</span></>}</button></div>
            </form>
          </section>
          <p className="privacy-note" id="privacy-note">Questions and feedback are saved for this pilot. Please leave out personal information.</p>
          {!session && !sessionError && <p className="connection-note" role="status">Connecting…</p>}
          {sessionError && <div className="error-panel" role="alert"><p>{sessionError}</p><button type="button" className="text-button" onClick={() => void connect()}>Try connecting again</button></div>}
          {requestError && <div className="error-panel" role="alert"><h2>Your submission could not be confirmed</h2><p>{requestError}</p>{canRetry && <button className="text-button" type="button" disabled={busy} onClick={() => { const retry = retryRef.current; if (retry) void ask(retry.payload.question, retry.payload.curatedSlug); }}>Retry this submission</button>}</div>}
          {busy && <section className="progress-panel" aria-live="polite"><div className="progress-heading"><h2><span className="working-dot" aria-hidden="true" />Checking the reviewed collection</h2><span className="small-note">{elapsed}s</span></div><p>{pendingQuestion}</p><p className="small-note">{elapsed >= 8 ? "Still checking. Your draft is kept until we confirm the result." : "Opening a reviewed answer, or saving a question for future coverage."}</p></section>}
          {!conversation && <section className="inspiration" aria-labelledby="inspiration-title"><h2 id="inspiration-title">Start with a question</h2><div className="suggestion-list">{initialQuestions.map((item) => <button type="button" key={item.slug} disabled={!session || busy} onClick={() => choose(item.slug)}>{item.short}<span aria-hidden="true">↗</span></button>)}</div><p className="small-note">Edited answers · Circle of competence</p></section>}

          {selected && !busy && <section className="answer-region" ref={answerRef} aria-label="Response">
            {selected.answer ? <article>
              <div className="answer-meta"><span className="answer-kind">{selected.kind === "curated" ? "Edited answer" : "Generated answer · checked against supplied passages"}</span><span>{selected.elapsedMs < 1000 ? "Ready to read" : `${(selected.elapsedMs / 1000).toFixed(1)}s`}</span></div>
              <h1>{selected.answer.title}</h1><div className="answer-lead">{paragraphs(selected.answer.lead)}</div>
              {selected.answer.sections.map(([heading, body], index) => <section className="answer-section" key={index}><h2>{heading}</h2>{paragraphs(body)}</section>)}
              {selected.answer.prompt && <aside className="reflection"><p className="eyebrow">A prompt for your research</p>{paragraphs(selected.answer.prompt)}{Boolean(selected.answer.prompt_refs?.length) && <p className="prompt-references">Source basis {selected.answer.prompt_refs?.map((key) => citation(key, `prompt-${key}`))}</p>}<p className="small-note">Editorial guidance from the cited examples; not a test that certifies competence.</p></aside>}
              <details className="answer-sources"><summary>Sources for this answer <span>{selected.answer.reference_keys.length}</span></summary><ol>{selected.answer.reference_keys.map((key, index) => <li key={key}><button type="button" onClick={() => openSource(key)}><span className="source-list-number">{index + 1}</span>{selected.references?.[key]?.label || officialSources[key]?.label || "Source unavailable"}</button></li>)}</ol><p className="small-note">Links open the original publisher. Dates, speaker attribution and paragraph locators are available in each source detail.</p></details>
              <p className="answer-limit">{selected.kind === "curated" ? "An editorial synthesis of selected original contexts. Historical examples preserve their original conditions; they do not establish today’s investment suitability." : "A model-assisted explanation of selected passages. The source check can miss context; verify important claims in the originals."}</p>
              {nextQuestion && <button className="next-question" type="button" disabled={busy} onClick={() => choose(nextQuestion.slug)}><span className="eyebrow">A related question</span><span>{nextQuestion.title} <span aria-hidden="true">→</span></span></button>}
            </article> : <div className="unavailable-answer">
              <p className="eyebrow">{selected.kind === "question_received" && selected.recorded ? "Question saved" : "Not covered by this collection"}</p>
              <h1>{selected.question}</h1>
              <p>{selected.kind === "question_received" && selected.recorded ? "Your question is saved to help us choose what to cover next. We do not have a reviewed answer for it yet." : selected.message || "No reviewed answer covers this question yet."}</p>
              {selected.kind === "question_received" && selected.recorded && <p className="small-note">An individual reply is not promised.</p>}
              {Boolean(selected.suggestions?.length) ? <div className="related-reading"><h2>Related reading—not an answer to your question</h2><p className="small-note">These reviewed questions share part of your topic.</p>{selected.suggestions?.map((item) => <button key={item.slug} type="button" onClick={() => choose(item.slug)}>{item.title}<span aria-hidden="true">→</span></button>)}</div> : <button className="secondary-button browse-questions" type="button" onClick={exploreQuestions}>Explore the six reviewed questions <span aria-hidden="true">→</span></button>}
            </div>}


            <section className="feedback-section" aria-labelledby="feedback-title">
              <div className="feedback-top"><h2 id="feedback-title">{selected.answer ? "Was this useful?" : "What would you want an answer to explain?"}</h2>{selected.answer && <div className="feedback-votes"><button type="button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving"} aria-pressed={currentFeedback.helpful === true} onClick={() => void saveFeedback(true)}>Yes</button><button type="button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving"} aria-pressed={currentFeedback.helpful === false} onClick={() => void saveFeedback(false)}>Not yet</button></div>}<p className="small-note" role="status">{currentFeedback.status === "saved" ? "Feedback saved. Thank you." : currentFeedback.status === "saving" ? "Saving…" : !session?.feedbackEnabled ? "Feedback is unavailable in this preview." : ""}</p></div>
              <details className="feedback-details" key={selected.id} open={!selected.answer}>
                <summary>{selected.answer ? "Tell us what could be better" : "Add context to your question (optional)"}</summary>
                <form onSubmit={(event) => { event.preventDefault(); void saveFeedback(); }}>
                  <label htmlFor="feedback-reason">{selected.answer ? "What was missing?" : "What would help?"}</label>
                  <select id="feedback-reason" value={currentFeedback.reason} onChange={(event) => updateFeedback({ reason: event.target.value as Reason })} disabled={currentFeedback.status === "saving"}>
                    <option value="">Choose a reason (optional)</option>
                    <option value="not_covered">My question is not covered</option>
                    <option value="too_general">More specific explanation</option>
                    <option value="unclear">Clearer explanation</option>
                    <option value="sources">More useful sources</option>
                    <option value="too_slow">A quicker experience</option>
                    <option value="other">Something else</option>
                  </select>
                  <label htmlFor="feedback-comment">{selected.answer ? "A little more detail (optional)" : "What are you trying to understand? (optional)"}</label>
                  <textarea id="feedback-comment" rows={3} maxLength={2000} value={currentFeedback.comment} disabled={currentFeedback.status === "saving"} onChange={(event) => updateFeedback({ comment: event.target.value })} placeholder="What did you hope to learn? Please leave out personal information." />
                  <button type="submit" className="secondary-button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving" || (currentFeedback.helpful === null && !currentFeedback.reason && !currentFeedback.comment.trim())}>{currentFeedback.status === "saving" ? "Saving…" : selected.answer ? "Send feedback" : "Save context"}</button>
                </form>
              </details>
              {currentFeedback.status === "error" && <p className="feedback-error" role="alert">{currentFeedback.error}</p>}
            </section>
          </section>}
        </main>
        <footer>Reading pilot · Start with the circle of competence.<br />Read the sources. Keep the conditions in view.</footer>
      </div>
      <dialog className="source-dialog" ref={dialogRef} aria-labelledby="source-title" onClose={() => setSource(null)} onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}>
        {source && <div className="source-inner"><div className="source-top"><p className="eyebrow">Source {source.number}</p><button type="button" className="close-button" aria-label="Close source details" onClick={() => dialogRef.current?.close()}>×</button></div><h2 id="source-title">{source.ref.label}</h2><p className="source-context">{source.ref.context_title}</p><dl className="source-metadata">{source.ref.report_year && <><dt>Report year</dt><dd>{source.ref.report_year}</dd></>}{source.ref.date && <><dt>{source.ref.date_kind === "signature_date" ? "Signed" : source.ref.date_kind === "event_date" ? "Event date" : "Date"}</dt><dd>{source.ref.date}</dd></>}{Boolean(source.ref.speakers?.length) && <><dt>Speaker / author</dt><dd>{source.ref.speakers?.join("; ")}</dd></>}</dl><p className="small-note">This explanation is not a quotation. Read the original publisher’s text to check its wording and surrounding context.</p>{sourceUrl ? <a className="publisher-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Read at the original publisher <span aria-hidden="true">↗</span></a> : <p className="small-note">A verified publisher link is not available for this reference.</p>}{Boolean(source.ref.paragraphs?.length) && <details className="source-locators"><summary>Paragraph locators</summary><ul>{source.ref.paragraphs?.map((paragraph) => <li key={paragraph.id}><strong>{paragraph.id}</strong>{paragraph.speaker && <span>{paragraph.speaker}</span>}{paragraph.locator && <SourceLocator locator={paragraph.locator} />}</li>)}</ul></details>}</div>}
      </dialog>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <noscript><p className="no-script">Please enable JavaScript to read reviewed answers and submit questions for future coverage.</p></noscript>
    </>
  );
}
