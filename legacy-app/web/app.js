'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const state = {ready: false, token: null, busy: false, job: null, entries: [], selectedId: null, followUpId: null, pollTimer: null, elapsedTimer: null, startedAt: 0, seenStages: new Set(), pollFailures: 0};
  const stages = ['queued', 'planning', 'retrieving', 'writing', 'checking'];
  const stageMessages = {queued: 'Waiting for the local worker.', planning: 'Interpreting the question and its context.', retrieving: 'Looking for relevant original passages.', writing: 'Preparing an answer from the retrieved evidence.', checking: 'Checking claims and citations against the retrieved passages.'};
  const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const localPage = ['http:', 'https:'].includes(location.protocol) && localHost;
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function say(message) { $('announcement').textContent = message; }
  function readable(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return JSON.stringify(value, null, 2);
  }
  function safeLink(value, localOnly = false) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      if (localOnly && (url.origin !== location.origin || !url.pathname.startsWith('/library/'))) return null;
      return url.href;
    } catch { return null; }
  }
  function updateControls() {
    document.body.classList.toggle('conversation-mode', state.busy || state.entries.length > 0);
    $('submit-question').disabled = !state.ready || state.busy;
    $('submit-question').replaceChildren(document.createTextNode(state.busy ? 'Preparing…' : 'Ask '));
    if (!state.busy) { const arrow = element('span', '', '↑'); arrow.setAttribute('aria-hidden', 'true'); $('submit-question').append(arrow); }
    $('question').disabled = !localPage;
    $('new-question').hidden = !state.entries.length && !state.followUpId;
  }
  function connection(message, status) {
    $('connection-message').textContent = message;
    $('connection-status').className = 'connection-status ' + status;
    $('check-connection').hidden = !localPage || status === 'ready';
    $('connection-row').hidden = status === 'ready';
  }
  function error(message, title = 'The question could not be completed', resumable = false) {
    $('error-title').textContent = title;
    $('error-message').textContent = message;
    $('request-error').hidden = false;
    $('resume-job').hidden = !resumable;
  }
  function clearError() { $('request-error').hidden = true; $('resume-job').hidden = true; }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      let data;
      try { data = await response.json(); } catch { throw new Error('The local server returned an unreadable response. Check the launcher’s terminal and reconnect.'); }
      if (!response.ok) {
        const message = text(data.error) || text(data.message) || `The local server returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The local service did not respond in time. Check that its launcher is still running.');
      if (err instanceof TypeError) throw new Error('The local service could not be reached. Keep the launcher running, then check the connection.');
      throw err;
    } finally { clearTimeout(timeout); }
  }
  async function checkStatus() {
    if (!localPage) return;
    $('check-connection').disabled = true;
    connection('Checking the local service…', '');
    try {
      const status = await request('/api/status');
      state.token = text(status.csrf_token) || null;
      state.ready = status.ready === true && Boolean(state.token);
      connection(text(status.message) || (state.ready ? 'Local service ready · answers use selected library passages' : 'The local model service is not ready.'), state.ready ? 'ready' : 'unavailable');
      if (status.scope) {
        $('service-scope').hidden = false;
        $('service-scope-body').replaceChildren(element(typeof status.scope === 'string' ? 'p' : 'pre', typeof status.scope === 'string' ? '' : 'scope-data', readable(status.scope)));
      }
      if (!state.ready && status.ready === true && !state.token) connection('The local service did not supply a request token. Restart the launcher and reconnect.', 'unavailable');
    } catch (err) {
      state.ready = false;
      connection(err.message, 'unavailable');
    } finally { $('check-connection').disabled = false; updateControls(); }
  }

  function getEntry(id) { return state.entries.find(entry => entry.id === id); }
  function ancestors(id) {
    const result = [];
    const visited = new Set();
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = getEntry(id);
      if (!entry) break;
      result.unshift(entry);
      id = entry.parentId;
    }
    return result;
  }
  function answerPlainText(answer) {
    const parts = [text(answer.title)];
    for (const block of array(answer.short_answer)) parts.push(text(block.text));
    for (const section of array(answer.sections)) {
      parts.push(text(section.heading));
      for (const block of array(section.paragraphs)) parts.push(text(block.text));
    }
    for (const block of array(answer.practical_implications)) parts.push(text(block.text));
    for (const limit of array(answer.limitations)) parts.push(text(limit));
    return parts.filter(Boolean).join('\n\n');
  }
  function setFollowUp(id) {
    state.followUpId = id;
    const entry = getEntry(id);
    $('composer-title').textContent = entry ? 'What would you like to ask next?' : 'What would you like to understand?';
    $('conversation-context').hidden = !entry;
    if (entry) {
      const count = Math.min(ancestors(id).length, 4);
      $('conversation-context').textContent = `Following up on: ${entry.question} · ${count} recent ${count === 1 ? 'answer' : 'answers'} included as context. Long answers may be shortened.`;
    }
    updateControls();
  }
  function focusQuestion() { $('question').focus(); $('question').scrollIntoView({block: 'center', behavior: 'smooth'}); }
  function useQuestion(question, followUpId = null) {
    setFollowUp(followUpId);
    $('question').value = question;
    focusQuestion();
  }
  function renderHistory() {
    $('visit-history').hidden = !state.entries.length;
    $('history-list').replaceChildren();
    state.entries.forEach((entry, i) => {
      const li = element('li');
      const button = element('button');
      button.type = 'button';
      button.setAttribute('aria-current', entry.id === state.selectedId ? 'true' : 'false');
      button.append(element('span', 'history-number', String(i + 1).padStart(2, '0')), element('span', 'history-title', entry.question));
      button.addEventListener('click', () => { $('visit-history').open = false; renderAnswer(entry); setFollowUp(entry.id); $('answer-region').querySelector('.answer-title').focus({preventScroll: true}); $('answer-region').scrollIntoView({block: 'start', behavior: 'smooth'}); });
      li.append(button); $('history-list').append(li);
    });
  }

  function sourceDisplayTitle(source) {
    const original = text(source?.title);
    const repairs = window.KB_TITLE_REPAIRS;
    if (!original || !repairs || typeof repairs !== 'object') return original || text(source?.id);
    // Display only: use the existing verified map, never infer an encoding repair.
    const matches = Object.values(repairs).filter(entry => entry &&
      entry.roundtrip_verified === true && entry.original_title === original &&
      typeof entry.reading_title === 'string' && entry.reading_title.length > 0);
    const titles = new Set(matches.map(entry => entry.reading_title));
    return titles.size === 1 ? titles.values().next().value : original;
  }

  function sourceDescription(source) {
    const parts = [];
    if (source.event_date) parts.push(String(source.event_date));
    if (typeof source.locator === 'string') parts.push(source.locator);
    else if (source.locator && typeof source.locator === 'object') {
      const loc = source.locator;
      if (loc.chapter_number !== undefined) parts.push(`Chapter ${loc.chapter_number}`);
      if (loc.physical_pdf_page !== undefined || loc.page !== undefined) parts.push(`Physical page ${loc.physical_pdf_page ?? loc.page}`);
      if (loc.printed_page !== undefined) parts.push(`Printed page ${loc.printed_page}`);
      if (loc.paragraph_index !== undefined || loc.paragraph !== undefined) parts.push(`Paragraph ${loc.paragraph_index ?? loc.paragraph}`);
    }
    return parts.join(' · ');
  }
  function openSource(source, quote, number) {
    $('source-number').textContent = number ? `Source ${number}` : 'Source excerpt';
    const target = $('source-content'); target.replaceChildren();
    const title = element('h2', '', source ? sourceDisplayTitle(source) : 'Source details unavailable'); title.id = 'source-title'; target.append(title);
    if (!source) {
      target.append(element('p', 'missing-source', 'This citation did not resolve to a source in the server response. It cannot be treated as verified evidence here.'));
    } else {
      const description = sourceDescription(source);
      if (description) target.append(element('p', 'meta', description));
      if (source.quality_note) target.append(element('p', 'source-quality', readable(source.quality_note)));
    }
    if (quote) {
      target.append(element('h3', '', 'Cited original excerpt'), element('blockquote', '', quote));
      if (source && text(source.text) && !text(source.text).replace(/\s+/g, ' ').includes(quote.replace(/\s+/g, ' '))) target.append(element('p', 'missing-source', 'This quote is not an exact match within the returned passage after whitespace normalization. Check the original source before relying on it.'));
    }
    if (source) {
      const links = element('div', 'source-links');
      for (const [url, label, local] of [[source.local_url, 'Read full source context ↗', true], [source.source_url, 'Open publisher source ↗', false]]) {
        const href = safeLink(url, local);
        if (href) { const a = element('a', '', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a); }
      }
      if (links.childNodes.length) target.append(links);
      target.append(element('h3', '', 'Retrieved text'));
      target.append(element('div', 'source-text', text(source.text) || 'No passage text was included in this response. Use the source link to inspect the original.'));
      if (source.locator && typeof source.locator === 'object') {
        const detail = element('details', 'review-details'); detail.append(element('summary', '', 'Exact source locator'), element('pre', 'scope-data', readable(source.locator))); target.append(detail);
      }
    }
    target.append(element('p', 'meta', 'Source text and historical statements retain their original context. A model check is not audio authentication or human verification.'));
    if (!$('source-dialog').open) $('source-dialog').showModal();
  }
  function renderBlock(block, sources, numbers) {
    const p = element('p', 'paragraph', text(block.text));
    const refs = array(block.citations);
    for (const ref of refs) {
      const id = text(ref.source_id);
      const source = sources.get(id);
      const number = numbers.get(id);
      const cite = element('button', 'citation', number ? `[${number}]` : '[source unavailable]');
      cite.type = 'button'; cite.setAttribute('aria-label', number ? `Read source ${number}: ${sourceDisplayTitle(source) || id}` : 'Inspect unresolved source citation');
      cite.addEventListener('click', () => openSource(source, text(ref.quote), number));
      p.append(cite);
    }
    return p;
  }
  function renderAnswer(entry) {
    state.selectedId = entry.id;
    const result = entry.result, answer = result.answer;
    const root = $('answer-region'); root.replaceChildren(); root.hidden = false;
    $('question-inspiration').hidden = true;
    const sourceList = array(result.sources);
    const sources = new Map(sourceList.map(source => [source.id, source]));
    const numbers = new Map(sourceList.map((source, i) => [source.id, i + 1]));
    const top = element('div', 'answer-topline');
    const reviewStatus = result.review ? text(result.review.status) : '';
    const scopeOnly = reviewStatus === 'scope_response';
    const reviewLabels = {model_checked_selected_passages: 'Experimental · checked against retrieved passages', scope_response: 'Experimental · scope check only', withheld: 'Experimental · draft withheld after checks'};
    top.append(element('p', 'eyebrow', reviewLabels[reviewStatus] || 'Experimental · review status unavailable'));
    const evidenceLabels = {sufficient: 'Evidence found for this answer', partial: 'Partial evidence', insufficient: 'Insufficient evidence'};
    top.append(element('span', 'evidence-status', evidenceLabels[answer.evidence_status] || 'Evidence status not supplied'));
    root.append(top);
    const h2 = element('h2', 'answer-title', text(answer.title) || entry.question); h2.tabIndex = -1; root.append(h2);
    root.append(element('p', 'asked-question', 'Your question: ' + entry.question));
    if (!scopeOnly && (answer.evidence_status === 'partial' || answer.evidence_status === 'insufficient')) root.append(element('p', 'evidence-boundary', answer.evidence_status === 'partial' ? 'The retrieved evidence supports only part of this question. Read the limits before carrying an idea into practice.' : 'The retrieved evidence does not support a complete answer. The explanation below identifies what is available and what is missing.'));
    if (array(answer.short_answer).length) {
      const short = element('section', 'short-answer'); short.append(element('h3', 'answer-label', 'The short answer'));
      for (const block of answer.short_answer) short.append(renderBlock(block, sources, numbers)); root.append(short);
    }
    for (const section of array(answer.sections)) {
      const part = element('section', 'answer-section'); if (section.heading) part.append(element('h3', '', section.heading));
      for (const block of array(section.paragraphs)) part.append(renderBlock(block, sources, numbers)); root.append(part);
    }
    if (array(answer.practical_implications).length) {
      const practical = element('section', 'answer-section practical-section'); practical.append(element('h3', '', 'Source-supported implications'));
      practical.append(element('p', 'meta', 'Editorial application of the cited passages; preserve their audience and conditions.'));
      for (const block of answer.practical_implications) practical.append(renderBlock(block, sources, numbers)); root.append(practical);
    }
    if (array(answer.limitations).length) {
      const limitations = element('section', 'limitations'); limitations.append(element('h3', '', 'What this answer does not establish'));
      const list = element('ul'); for (const limit of answer.limitations) list.append(element('li', '', readable(limit))); limitations.append(list); root.append(limitations);
    }
    const sourceDetails = element('details', 'source-list'); sourceDetails.append(element('summary', '', `Retrieved sources (${sourceList.length})`));
    const items = element('ol', 'source-items');
    sourceList.forEach((source, index) => {
      const li = element('li', 'source-item'); li.append(element('span', 'source-index', String(index + 1)));
      const body = element('div'), button = element('button', '', sourceDisplayTitle(source)); button.type = 'button'; button.addEventListener('click', () => openSource(source, '', index + 1)); body.append(button);
      const description = sourceDescription(source); if (description) body.append(element('p', 'meta', description)); li.append(body); items.append(li);
    });
    if (!sourceList.length) sourceDetails.append(element('p', 'meta', 'No source passages were returned. This answer has no inspectable source support in this response.'));
    sourceDetails.append(items); root.append(sourceDetails);
    const review = element('details', 'review-details'); review.append(element('summary', '', 'Review and retrieval scope'));
    review.append(element('p', '', scopeOnly ? 'This response only checks the library’s scope. No source retrieval or factual answer review was performed.' : 'This is a scoped model check of the retrieved passages, not human verification, audio authentication or complete coverage of Buffett’s views.'));
    if (result.review) {
      review.append(element('p', '', 'Reported review status: ' + (text(result.review.status) || 'not supplied')));
      if (Array.isArray(result.review.notes)) { const list = element('ul'); for (const note of result.review.notes) list.append(element('li', '', readable(note))); review.append(list); }
      else if (result.review.notes) review.append(element('p', '', readable(result.review.notes)));
    }
    if (result.scope) review.append(element('pre', 'scope-data', readable(result.scope)));
    if (result.timing) { const timing = element('details'); timing.append(element('summary', '', 'Preparation timing'), element('pre', 'scope-data', readable(result.timing))); review.append(timing); }
    root.append(review);
    const questions = array(answer.follow_up_questions).filter(q => typeof q === 'string' && q.trim());
    if (questions.length) {
      const follow = element('section', 'followups'); follow.append(element('h3', '', 'Keep exploring'));
      const list = element('div', 'followup-list'); for (const question of questions) { const button = element('button'); button.type = 'button'; button.append(element('span', '', question), element('span', '', '↗')); button.addEventListener('click', () => useQuestion(question, entry.id)); list.append(button); } follow.append(list); root.append(follow);
    }
    const continueButton = element('button', 'secondary-button continue-answer', 'Ask your own follow-up ↑'); continueButton.type = 'button'; continueButton.addEventListener('click', () => { setFollowUp(entry.id); focusQuestion(); }); root.append(continueButton);
    renderHistory();
  }

  function updateProgress(status, message) {
    state.seenStages.add(status);
    for (const node of $('progress-steps').children) {
      const stage = node.dataset.stage;
      node.className = stage === status ? 'current' : state.seenStages.has(stage) ? 'visited' : '';
      if (stage === status) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    }
    const next = message || stageMessages[status] || 'Waiting for a status update from the local service.';
    if ($('progress-message').textContent !== next) $('progress-message').textContent = next;
  }
  function stopTimers() { clearTimeout(state.pollTimer); clearInterval(state.elapsedTimer); state.pollTimer = null; state.elapsedTimer = null; }
  function finishJob() { stopTimers(); state.busy = false; state.job = null; $('job-progress').hidden = true; updateControls(); }
  function validResult(result) {
    if (!result || typeof result !== 'object' || !result.answer || typeof result.answer !== 'object') return false;
    const answer = result.answer;
    const validBlocks = list => Array.isArray(list) && list.every(block => block && typeof block === 'object' && typeof block.text === 'string' && Array.isArray(block.citations) && block.citations.every(ref => ref && typeof ref.source_id === 'string' && typeof ref.quote === 'string'));
    if (!validBlocks(answer.short_answer) || !validBlocks(answer.practical_implications)) return false;
    if (!Array.isArray(answer.sections) || !answer.sections.every(section => section && typeof section.heading === 'string' && validBlocks(section.paragraphs))) return false;
    if (!Array.isArray(result.sources) || !result.sources.every(source => source && typeof source.id === 'string' && typeof source.title === 'string' && typeof source.text === 'string')) return false;
    return Array.isArray(answer.limitations) && Array.isArray(answer.follow_up_questions);
  }
  async function pollJob() {
    if (!state.job) return;
    const job = state.job;
    try {
      const data = await request('/api/jobs/' + encodeURIComponent(job.id));
      if (state.job !== job) return;
      state.pollFailures = 0; clearError();
      if (data.status === 'complete') {
        if (!validResult(data.result)) { finishJob(); error('The local server returned an unexpected answer format. Existing answers are still available. Check the launcher’s terminal before trying again.'); return; }
        const entry = {id: 'answer-' + (state.entries.length + 1), parentId: job.parentId, question: text(data.result.question) || job.question, result: data.result};
        state.entries.push(entry); finishJob(); renderAnswer(entry); setFollowUp(entry.id);
        if ($('question').value.trim() === job.question) $('question').value = '';
        say(array(data.result.sources).length ? 'The answer is ready. Open its numbered citations to inspect the evidence.' : 'The response is ready. No source passages were returned.');
        $('answer-region').scrollIntoView({block: 'start', behavior: 'smooth'});
        return;
      }
      if (data.status === 'error') {
        let message = text(data.error) || text(data.message) || 'The local service could not prepare this answer. Check its terminal for details; your earlier answers remain available.';
        if (message === 'The Codex usage limit was reached. Check your account allowance and try later.') message = 'The model request could not finish. A service limit was reported, but this app has not verified that your account allowance is exhausted. Check Codex and your connection before trying again. No answer was released.';
        finishJob(); error(message); say('The question could not be completed.'); return;
      }
      if (!stages.includes(data.status)) throw new Error('The local service returned an unknown job state. Reconnect to check this question; do not submit it again yet.');
      updateProgress(data.status, text(data.message));
      state.pollTimer = setTimeout(pollJob, 1500);
    } catch (err) {
      if (state.job !== job) return;
      state.pollFailures += 1;
      if (state.pollFailures <= 3) {
        $('progress-message').textContent = 'Connection interrupted. Checking the same question again; no new question is being submitted.';
        state.pollTimer = setTimeout(pollJob, 2000 * state.pollFailures);
      } else {
        clearInterval(state.elapsedTimer); state.elapsedTimer = null;
        error(err.message + ' Your question may still be running. Reconnect to this question to check its result.', 'Connection to this question was interrupted', true);
        $('progress-message').textContent = 'Status updates paused. The question has not been cancelled.';
      }
    }
  }
  function startElapsed() {
    clearInterval(state.elapsedTimer);
    const update = () => { const seconds = Math.floor((Date.now() - state.startedAt) / 1000); $('elapsed-time').textContent = seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`; };
    update(); state.elapsedTimer = setInterval(update, 1000);
  }
  async function submitQuestion(event) {
    event.preventDefault();
    if (state.busy || !state.ready || !localPage) return;
    const question = $('question').value.trim();
    if (!question) { $('question').focus(); return; }
    const parentId = state.followUpId;
    const history = ancestors(parentId).slice(-4).map(entry => ({question: entry.question, answer: answerPlainText(entry.result.answer).slice(0, 6000)}));
    clearError(); state.busy = true; state.seenStages = new Set(); state.pollFailures = 0; updateControls();
    $('job-progress').hidden = false; $('working-question').textContent = question; updateProgress('queued', 'Sending the question to the local service…'); state.startedAt = Date.now(); startElapsed();
    try {
      const data = await request('/api/questions', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-QA-Token': state.token}, body: JSON.stringify({question, history})});
      if (typeof data.job_id !== 'string' || !data.job_id) throw new Error('The server did not return a question ID. Check its terminal before trying again.');
      state.job = {id: data.job_id, question, parentId}; say('Your question is being prepared.'); pollJob();
    } catch (err) {
      finishJob(); error(err.message + ' If the connection failed after submission, acceptance could not be confirmed. Check the local service before submitting again.', 'The question could not be confirmed');
      checkStatus();
    }
  }

  $('question-form').addEventListener('submit', submitQuestion);
  $('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!state.busy && state.ready) $('question-form').requestSubmit(); } });
  $('new-question').addEventListener('click', () => { setFollowUp(null); $('question').value = ''; focusQuestion(); say('Started a new question. Earlier answers are still available below.'); });
  $('check-connection').addEventListener('click', checkStatus);
  $('resume-job').addEventListener('click', () => { if (!state.job) return; clearError(); state.pollFailures = 0; startElapsed(); pollJob(); });
  document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => useQuestion(button.dataset.question)));
  $('close-source').addEventListener('click', () => $('source-dialog').close());
  $('source-dialog').addEventListener('click', event => { if (event.target === $('source-dialog')) { const rect = $('source-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('source-dialog').close(); } });
  window.addEventListener('pagehide', stopTimers);
  const menus = [...document.querySelectorAll('.header-menu')];
  menus.forEach(menu => menu.addEventListener('toggle', () => { if (menu.open) menus.forEach(other => { if (other !== menu) other.open = false; }); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('source-dialog').open) menus.forEach(menu => { if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); } }); });
  if (!localPage) {
    $('launcher-notice').hidden = false;
    connection('Open the localhost address supplied by the project’s local Q&A launcher.', 'unavailable');
    document.querySelectorAll('a[href^="/library/"]').forEach(link => { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.title = 'Available after starting the local launcher.'; });
    updateControls();
  } else checkStatus();
})();
