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
  kind: "curated" | "generated" | "suggestions" | "unavailable";
  question: string;
  answer?: Answer;
  references?: Record<string, Source>;
  message?: string;
  suggestions?: { slug: string; title: string; short: string }[];
  elapsedMs: number;
};
type Session = { csrfToken: string; generationEnabled: boolean; feedbackEnabled: boolean; contentVersion: string };
type Reason = "too_general" | "unclear" | "sources" | "too_slow" | "other" | "";
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
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Result[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [requestError, setRequestError] = useState("");
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [source, setSource] = useState<{ ref: Source; number: number; key: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const selected = entries.find((entry) => entry.id === selectedId);
  const conversation = busy || Boolean(selected);
  const currentFeedback = selected ? feedback[selected.id] || emptyFeedback : emptyFeedback;

  async function connect(signal?: AbortSignal) {
    setSessionError("");
    try {
      const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("The service could not connect. Please try again.");
      const data: Session = await response.json();
      if (!data.csrfToken) throw new Error("The service did not return a valid session. Please try again.");
      setSession(data);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setSessionError(errorMessage(error, "The service could not connect. Please try again."));
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
    setQuestion("");
    setRequestError("");
    setAnnouncement("New question. Previous answer context has been cleared.");
    inputRef.current?.focus();
  }

  async function ask(text: string, curatedSlug?: string) {
    const cleaned = text.trim();
    if (!session || busy || cleaned.length < 3 || cleaned.length > 2000) return;
    closeMenus();
    setQuestion(cleaned);
    setPendingQuestion(cleaned);
    setRequestError("");
    setBusy(true);
    setElapsed(0);
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 100000);
    try {
      const response = await fetch("/api/questions", {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ question: cleaned, ...(curatedSlug ? { curatedSlug } : {}), ...(!curatedSlug && selected?.answer ? { previousAnswerId: selected.id } : {}) }),
      });
      const data = await response.json() as Result & { error?: string };
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "The request could not be completed. Your question is still here; please try again.");
      if (!data.id || !["curated", "generated", "suggestions", "unavailable"].includes(data.kind)) throw new Error("The response was incomplete. Please try again.");
      const result = data as Result;
      setEntries((previous) => [...previous, result]);
      setSelectedId(result.id);
      if (result.answer) setQuestion("");
      setAnnouncement(result.answer ? "Your answer is ready. Citations open the source details." : "Live answer unavailable. Related reading is shown separately.");
      window.setTimeout(() => answerRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 50);
    } catch (error) {
      setRequestError(errorMessage(error, "This request took too long. Your question has been kept. Please try again."));
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
    setFeedback((previous) => ({ ...previous, [selected.id]: { ...(previous[selected.id] || emptyFeedback), ...patch, status: "idle" } }));
  }

  async function saveFeedback(helpful: boolean | null = currentFeedback.helpful) {
    if (!session || !selected || !session.feedbackEnabled || currentFeedback.status === "saving") return;
    const id = selected.id;
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
      setFeedback((previous) => ({ ...previous, [id]: { ...payload, status: "saved" } }));
    } catch (error) {
      setFeedback((previous) => ({ ...previous, [id]: { ...payload, status: "error", error: errorMessage(error, "Feedback could not be saved. Please try again.") } }));
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
            {entries.length > 0 && <details className="header-menu" onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>Your questions</summary>
              <div className="menu-panel history-panel"><h2 className="sr-only">Your questions</h2><ol>{entries.map((entry) => <li key={entry.id}><button type="button" disabled={busy} aria-current={selectedId === entry.id ? "true" : undefined} onClick={() => { closeMenus(); setSelectedId(entry.id); setQuestion(""); setRequestError(""); }}>{entry.question}</button></li>)}</ol><p className="small-note">Page history clears on reload. Submitted questions remain in the beta records.</p></div>
            </details>}
            <details className="header-menu" onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>Explore</summary>
              <div className="menu-panel explore-panel"><p className="eyebrow">Circle of competence</p><p className="menu-description">Six edited answers, ready to read.</p><ol>{content.questions.map((item) => <li key={item.slug}><button type="button" disabled={!session || busy} onClick={() => choose(item.slug)}><span className="question-number">{item.number}</span><span>{item.title}</span></button></li>)}</ol></div>
            </details>
            <details className="header-menu" onToggle={(event) => { if (event.currentTarget.open) closeMenus(event.currentTarget); }}>
              <summary>About</summary>
              <div className="menu-panel about-panel"><h2>Close to the sources.</h2><p>A question book about Buffett and Munger, beginning with the circle of competence. This preview covers selected primary contexts for one topic—not everything they have said.</p><h3>Two kinds of answer</h3><p><strong>Edited answers</strong> are prepared explanations with a scoped independent agent review. They are editorial syntheses, not Buffett’s own answer to your question. Source links let you check the original context.</p><p><strong>Generated answers</strong>, when enabled, are composed from selected passages and checked against them. That check is not human verification or a complete search of Buffett’s work.</p><p>{session?.generationEnabled ? "Live answers are enabled for this preview." : "Live answers are not enabled in this preview. You can read the six edited answers now."} Responses are in English. There is no current-market feed or assessment of any investment’s suitability today.</p><h3>Your questions and feedback</h3><p>Submitted questions, responses and feedback are saved to improve this beta. Please do not include personal or confidential information. No contact details are requested.</p><p>When live answers are enabled, your question, relevant prior-answer context and selected public passages are sent to the configured model service. The provider has its own data-handling terms.</p><p>Your visible conversation is held in this page and clears on reload. That does not delete submitted beta records.</p></div>
            </details>
          </nav>
        </header>

        <main>
          {!conversation && <section className="hero" aria-labelledby="page-title"><p className="eyebrow">A question book, rooted in the originals</p><h1 id="page-title">What would you like<br className="hero-break" /> to understand?</h1><p>Explore Buffett and Munger’s ideas, with the sources in reach.</p></section>}
          <section className="composer" aria-label="Ask a question">
            {conversation && <div className="composer-heading"><h2>{selected?.answer ? "Ask a follow-up" : "Your question"}</h2><button type="button" className="text-button" onClick={newQuestion} disabled={busy}>New question</button></div>}
            {selected?.answer && <p className="context-note">Following up on: <span>{selected.question}</span></p>}
            <form onSubmit={submit}>
              <label className="sr-only" htmlFor="question">Your question</label>
              <textarea ref={inputRef} id="question" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (question.trim().length >= 3) void ask(question); } }} rows={2} minLength={3} maxLength={2000} required disabled={busy} placeholder={selected?.answer ? "What would you like to go deeper into?" : "Ask a question about investing and understanding businesses…"} aria-describedby="privacy-note question-help" />
              <div className="composer-actions"><p id="question-help"><span className="keyboard-hint">⌘ / Ctrl + Enter</span><span className="sr-only"> to ask. Enter 3 to 2,000 characters.</span></p><button type="submit" className="primary-button" disabled={!session || busy || question.trim().length < 3}>{busy ? "Working…" : <>Ask <span aria-hidden="true">↑</span></>}</button></div>
            </form>
          </section>
          <p className="privacy-note" id="privacy-note">Questions, responses and feedback are saved to improve this beta.</p>
          {!session && !sessionError && <p className="connection-note" role="status">Connecting…</p>}
          {sessionError && <div className="error-panel" role="alert"><p>{sessionError}</p><button type="button" className="text-button" onClick={() => void connect()}>Try connecting again</button></div>}
          {requestError && <div className="error-panel" role="alert"><h2>Your question could not be completed</h2><p>{requestError}</p></div>}
          {busy && <section className="progress-panel" aria-live="polite"><div className="progress-heading"><h2><span className="working-dot" aria-hidden="true" />Preparing your response</h2><span className="small-note">{elapsed}s</span></div><p>{pendingQuestion}</p><p className="small-note">{elapsed >= 25 ? "Still working. Your question is being kept here." : "The response will appear here when it is ready."}</p></section>}
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
            </article> : <div className="unavailable-answer"><p className="eyebrow">Your question</p><h1>{selected.question}</h1><p>{selected.message || "Live answers are not enabled in this preview."}</p>{!session?.generationEnabled && !selected.message?.includes("Live answers are not enabled") && <p className="small-note">Live answers are not enabled in this preview.</p>}{Boolean(selected.suggestions?.length) && <div className="related-reading"><h2>Related reading—not an answer to your question</h2><p className="small-note">These edited questions may help you explore the topic.</p>{selected.suggestions?.map((item) => <button key={item.slug} type="button" onClick={() => choose(item.slug)}>{item.title}<span aria-hidden="true">→</span></button>)}</div>}</div>}

            <section className="feedback-section" aria-labelledby="feedback-title">
              <div className="feedback-top"><h2 id="feedback-title">Was this useful?</h2><div className="feedback-votes"><button type="button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving"} aria-pressed={currentFeedback.helpful === true} onClick={() => void saveFeedback(true)}>Yes</button><button type="button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving"} aria-pressed={currentFeedback.helpful === false} onClick={() => void saveFeedback(false)}>Not yet</button></div><p className="small-note" role="status">{currentFeedback.status === "saved" ? "Thank you. Feedback saved." : currentFeedback.status === "saving" ? "Saving…" : !session?.feedbackEnabled ? "Feedback is unavailable in this preview." : ""}</p></div>
              <details className="feedback-details"><summary>Tell us what could be better</summary><form onSubmit={(event) => { event.preventDefault(); void saveFeedback(); }}><label htmlFor="feedback-reason">What was missing?</label><select id="feedback-reason" value={currentFeedback.reason} onChange={(event) => updateFeedback({ reason: event.target.value as Reason })} disabled={currentFeedback.status === "saving"}><option value="">Choose a reason (optional)</option><option value="too_general">Too general</option><option value="unclear">Hard to understand</option><option value="sources">Sources did not help</option><option value="too_slow">Too slow</option><option value="other">Something else</option></select><label htmlFor="feedback-comment">A little more detail (optional)</label><textarea id="feedback-comment" rows={3} maxLength={2000} value={currentFeedback.comment} disabled={currentFeedback.status === "saving"} onChange={(event) => updateFeedback({ comment: event.target.value })} placeholder="What did you hope to learn? Please leave out personal information." /><button type="submit" className="secondary-button" disabled={!session?.feedbackEnabled || currentFeedback.status === "saving" || (currentFeedback.helpful === null && !currentFeedback.reason && !currentFeedback.comment.trim())}>{currentFeedback.status === "saving" ? "Saving…" : "Send feedback"}</button></form></details>
              {currentFeedback.status === "error" && <p className="feedback-error" role="alert">{currentFeedback.error}</p>}
            </section>
          </section>}
        </main>
        <footer>Early preview · Start with the circle of competence.<br />Read the sources. Keep the conditions in view.</footer>
      </div>
      <dialog className="source-dialog" ref={dialogRef} aria-labelledby="source-title" onClose={() => setSource(null)} onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}>
        {source && <div className="source-inner"><div className="source-top"><p className="eyebrow">Source {source.number}</p><button type="button" className="close-button" aria-label="Close source details" onClick={() => dialogRef.current?.close()}>×</button></div><h2 id="source-title">{source.ref.label}</h2><p className="source-context">{source.ref.context_title}</p><dl className="source-metadata">{source.ref.report_year && <><dt>Report year</dt><dd>{source.ref.report_year}</dd></>}{source.ref.date && <><dt>{source.ref.date_kind === "signature_date" ? "Signed" : source.ref.date_kind === "event_date" ? "Event date" : "Date"}</dt><dd>{source.ref.date}</dd></>}{Boolean(source.ref.speakers?.length) && <><dt>Speaker / author</dt><dd>{source.ref.speakers?.join("; ")}</dd></>}</dl><p className="small-note">This explanation is not a quotation. Read the original publisher’s text to check its wording and surrounding context.</p>{sourceUrl ? <a className="publisher-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Read at the original publisher <span aria-hidden="true">↗</span></a> : <p className="small-note">A verified publisher link is not available for this reference.</p>}{Boolean(source.ref.paragraphs?.length) && <details className="source-locators"><summary>Paragraph locators</summary><ul>{source.ref.paragraphs?.map((paragraph) => <li key={paragraph.id}><strong>{paragraph.id}</strong>{paragraph.speaker && <span>{paragraph.speaker}</span>}{paragraph.locator && <SourceLocator locator={paragraph.locator} />}</li>)}</ul></details>}</div>}
      </dialog>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <noscript><p className="no-script">Please enable JavaScript to explore the edited answers and ask questions.</p></noscript>
    </>
  );
}
