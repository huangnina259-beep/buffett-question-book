# Buffett Question Book: engineering handoff

The main problem is **unreliable free-form, source-grounded answers**. A concrete failure occurs before any model call: **“how to be a great investor” retrieves zero source contexts** in the current website, even though the wider archive contains relevant material. The live site uses a small lexical index, not the full knowledge archive. Start with the [retrieval diagnosis](diagnostics/retrieval/README.md). Do not treat the seven reviewed answers, a working input box, a passing build, or a model response with citations as proof that this problem is solved.

This document describes application commit `58bca6e0857e898c453261e01956be51e2a17c5f`, inspected on 2026-11-05. The application belongs at the repository root; the accompanying offline scripts belong in `diagnostics/`. `legacy-retrieval/` and `data/`, if included separately, are research/archive material rather than the active website's retrieval engine.

## What currently works, and what does not

- Seven exact reviewed questions return stored editorial answers without inference. The stock-evaluation question was added to this set. Its fast success **does not exercise free-form generation**.
- Arbitrary supported questions can produce generated answers, but repeated questions have also failed formatting, citation or source-support checks. A recorded hosted working-capital example succeeded in about 19 seconds; earlier local attempts at related questions were withheld. These are individual observations, not a measured success rate or latency benchmark.
- Some earlier drafts passed mechanical citation checks but introduced unsupported reasoning. Examples included expanding a particular Berkshire-credit uncertainty into a rule about all external financing, adding portfolio-stress claims, and inventing a LIFO-to-cash/inflation mechanism. A later example substituted depreciation alone for the complete noncash-charge component of the owner-earnings formula.
- A separate automated source check now gates publication. It can reject questionable drafts, but it uses the same model, can fail or miss errors, and has not been calibrated on a sufficient held-out evaluation set. Known failure examples are explicitly described in the prompts, so passing those examples is targeted regression evidence, not independent proof of general reliability.

The application's unavailable messages intentionally withhold drafts rather than fabricate a successful answer. The engineering goal is to improve useful grounded-answer yield while retaining that boundary.

## Run the no-network, no-paid-call reproduction

Use Node.js 24 LTS for the supplied diagnostics, especially `node:sqlite`. The package advertises Node >=22.13, but the recorded development checks used Node 24. The npm lockfile is authoritative for dependencies.

From the repository root, with dependencies already installed:

```sh
node --version
node diagnostics/run-offline.mjs
```

These scripts do not read `.dev.vars`, API keys or existing session databases. Backend checks create an in-memory SQLite database, replace the Cloudflare binding with a D1-like adapter and replace provider fetch with explicit test doubles. Transport checks inject mock streams. Parser/retrieval checks only load repository files. The runner removes inherited `MODEL_*` settings from child environments and disables generation there. None of these commands regenerates a real model answer.

If dependencies are missing, installation is a separate step that normally uses the package registry, but makes no model calls:

```sh
npm ci --no-audit --no-fund
```

If the npm cache is already complete and all installation must remain offline:

```sh
npm ci --offline --no-audit --no-fund
```

The offline suite contains:

| Command | What it checks |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | Source type checking |
| `node diagnostics/offline-backend-checks.mjs` | 29 route/state/budget/reviewer/dedup/privacy scenarios, with mocked inference |
| `node diagnostics/flat-writer-32-checks.mjs` | 22 parser/citation/quotation scenarios; the historical filename does not identify the current writer version |
| `node diagnostics/stream-check.mjs` | 27 bounded transport cases, including rejection of a cross-origin redirect |
| `node diagnostics/check-retrieval.mjs` | Eight routing cases, including the known zero-context investor-question gap, and byte identity of included source snapshots |
| `node diagnostics/replay-saved-outputs.mjs` | Replays three immutable historical model outputs through the current parser |

Generated reports are written to `test-results/backend/` (created automatically). Keep that directory untracked. Historical reports are preserved separately under `diagnostics/baselines/`; rerunning tests does not overwrite them. A passing known-gap test records the current defect; it does not classify empty retrieval as desirable behavior. The saved-output fixtures reproduce a historical invalid-JSON response without a provider call. Other historical responses may now pass because tightly scoped formatting rules changed. **Parser acceptance is never semantic approval.** Tests with fabricated mock text prove pipeline behavior, not model quality.

## Current architecture and code entry points

| Area | Files |
| --- | --- |
| Browser UI, composer, citations, history | `app/page.tsx`, `app/globals.css`, `lib/pilot-types.ts` |
| Session and request API | `app/api/session/route.ts`, `app/api/questions/route.ts`, `app/api/feedback/route.ts` |
| Exact reviewed-answer selection | `lib/server/content.ts`, `lib/content/public-content.json` |
| Actual retrieval | `lib/retrieved-evidence.ts`, `lib/content/live-retrieval-index.json`, `lib/content/live-evidence-packets.json` |
| Writer prompt and response conversion | `lib/generation-prompt.ts` |
| Mechanical source-key/quote checks | `lib/generation-contract.ts` |
| Separate source-check prompt and verdict parsing | `lib/grounding-review.ts` |
| Provider transport | `lib/model-provider.ts`, `lib/provider-config.ts` |
| Paid-call orchestration, cache, permanent budget | `lib/server/generation.ts` |
| Storage, migrations | `db/index.ts`, `db/schema.ts`, `drizzle/` |

The stack is React 19.2.6, Next-compatible application APIs, Vinext 1.0.0-beta.5 on Vite 8.0.13, Cloudflare Workers, D1 and Drizzle 0.45.2. It is **not** a conventional `next start` server. `npm run build` calls the starter's framework launcher; `npm start` runs the built Worker locally through Wrangler 4.92.0.

The active pipeline is:

1. Require the anonymous session, same-origin request and CSRF header. Apply the client UUID/payload idempotency check.
2. Return an exact reviewed answer when its title/short question matches. A supplied slug must also match its question.
3. Select complete bounded contexts through lexical topic terms, required context groups and a broad-evaluation bundle. This is **not semantic retrieval over the entire archive**. The snapshot has 19 contexts and 514 paragraph entries; some contexts overlap.
4. Claim a session-scoped generation job and atomically reserve a writer attempt. Build a source-only writer prompt. Previous answer text, when present, is bounded conversation context rather than evidence.
5. Collect the complete provider response, enforce its transport/output limits, parse paragraph objects, require authorized source keys on every paragraph and validate direct quotations.
6. Build a separate source-check request containing the exact parsed draft, question and complete selected contexts. Atomically reserve its own attempt. Publish only a strict `supported: true` verdict with an empty issues array.
7. Persist the completed result, citation excerpts, safe metadata and usage aggregate. Otherwise persist a deterministic unavailable response. Neither private reviewer issues nor an unvalidated draft are returned as alternate answer text.

## Verified source settings at this snapshot

Read the source constants before changing anything: the main README and original content contract have some historical counts/versions.

| Setting | Current source |
| --- | --- |
| Writer | `source-grounded-writer-3.6`; JSON paragraph objects with per-paragraph citation arrays |
| Reviewer | `source-grounding-review-1.3`; strict `{supported, issues}` verdict |
| Selected provider/model | MarsAPI HTTPS chat-completions; `Qwen3.8-Flash-Next-W8A8` in the example configuration |
| Writer reasoning | `chat_template_kwargs.enable_thinking: true`, `reasoning_effort: low` |
| Reviewer reasoning | `chat_template_kwargs.enable_thinking: false`; no reasoning-effort field |
| Format | `response_format: {type: "json_object"}`; provider-enforced JSON Schema is not active |
| Stage limits | Writer 60 seconds; reviewer 45 seconds; 4,096 output tokens each; serialized input <=120,000 bytes each |
| Retrieval limits | At most eight complete contexts and 60,000 source characters |
| Recovery | 135-second generation-job lease; UI deadline 150 seconds |
| Trial budget | Permanent global 20 provider attempts, at most 20 per UTC day, CNY5 conservative reserved estimate |

The adapter uses bounded SSE internally but publishes only a complete checked answer. It does not expose thinking text or partially verified answer tokens to the browser. `generationEnabled` only means configuration is present and allowed; it is not a successful provider-health test.

Each fresh successful answer normally needs two separately reserved calls. Thus a fresh 20-attempt ledger permits at most ten fully checked answers; prior use and failures reduce that number. Reservations are not refunded. Missing usage from any attempted stage makes the job aggregate unknown. The ceiling is an application-side estimate, not a provider account billing cap.

The provider identifiers and price information were inspected through that provider; they do not independently establish the underlying model weights or routing. Do not substitute an OpenAI SDK assumption for observed gateway behavior.

## Failure modes to investigate

| Symptom | Meaning / evidence |
| --- | --- |
| `validation_json`, `validation_structure`, `validation_uncited_paragraph` | JSON-object mode does not enforce the expected fields or citations. Shorter/structured prompts improved some examples but did not make output reliable. Do not remove the citation gate to hide this. |
| `grounding_rejected` | The separate model pass objected to source support. The current database intentionally keeps a fixed code, not its detailed private critique. This can include true defects or overly strict review; that distinction needs a labeled evaluation. |
| `grounding_truncated`, `grounding_timeout`, `grounding_validation` | The reviewer did not produce an acceptable bounded verdict. Earlier 1,500-token thinking reviews exhausted output. The current reviewer is non-thinking with 4,096 tokens. |
| `global_budget`, `grounding_budget` | A deliberate allowance boundary, not evidence that the API or corpus is broken. The second reservation can fail after a writer has completed. |
| No relevant contexts | “how to be a great investor” currently selects zero contexts, so the provider is not called. See [retrieval diagnosis](diagnostics/retrieval/README.md). The active lexical index has limited topic coverage. Adding archive files under `data/` alone does not make them retrievable by this app. |
| Immediate `network` in early Worker tests | A resolved runtime bug: Workers rejects `redirect: "error"` during Request construction. The adapter now uses `manual` and rejects non-2xx results without forwarding credentials. |
| Earlier 50–90 second hangs / truncation | Several provider/model/mode combinations did not finish. Changes to streaming, reasoning and token settings affected latency. Separate these transport/serving failures from semantic quality. |

Additional engineering observations:

- Mechanical citation existence and exact quotations cannot establish that surrounding claims follow from the sources. The second model pass adds a check, not proof.
- Writer and reviewer prompts contain specific known failure examples. Create held-out, independently labeled questions before generalizing their apparent improvement.
- The current reviewer input-size estimator serializes writer-style thinking options, while the actual reviewer sends non-thinking options. This slightly overestimates review request size/reservation; it is a mismatch to clean up, not an established explanation for bad answers.
- The writer prompt asks for output within 2,200 tokens while the transport permits 4,096. This is not the same as changing the hard transport cap.
- Fixed error codes are safe but insufficient to diagnose semantic rejections. Consider an explicit opt-in diagnostic capture of sanitized stage outputs for development, rather than logging user questions, sources, credentials or responses indiscriminately.
- Existing reports are versioned observations. A later successful sample does not erase an earlier failure; a previous passing mock report is not proof that a later revision was exercised.

## Local UI / Worker preview with inference disabled

Use a clean clone with no credential files. The following creates only local state; do not substitute a production D1 binding or copy an existing session database.

```sh
cp .env.example .dev.vars
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_clear_iron_lad.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_wandering_cloak.sql
npm start -- --port 8801 --env-file "$(pwd)/.dev.vars"
```

Apply these migrations only once to a new local database. The template has `GENERATION_ENABLED=false` and a blank key. Inspect `http://127.0.0.1:8801/`; reviewed answers work and free-form inference is deliberately unavailable. Tooling disables Cloudflare metadata fetching and telemetry by default. The offline suite above remains the appropriate no-network reproduction; preview binds a loopback HTTP server.

`vite.config.ts` and `.openai/hosting.json` declare the `DB` D1 binding. Production entry is `worker/index.ts`. The hosting project identifier is a deployment identifier, not a local database credential. Local D1 uses the placeholder identifier and `.wrangler/state`; actual hosted authentication/audience and bindings belong to the hosting control plane. A standalone deployment requires separate infrastructure setup. This handoff does not authorize publishing or changing the existing Site's audience.

## Preserve these boundaries while fixing reliability

- Source texts, dates, author uncertainty, adjacent qualifications and Buffett/Munger attribution must remain intact. The English original sources are not translated in this phase.
- Keep `lib/content/*evidence*.json` server-only. The browser may receive selected excerpts and metadata, not unrestricted archive exports through a debugging route.
- Do not include `.dev.vars*`, real `.env*`, `.wrangler/`, `.sites-runtime/`, browser cookies, credentials, session databases or model-account exports in commits. `.env.example` is a blank template. Scan Git history as well as the working tree before sharing.
- Do not reset the permanent budget ledger during ordinary deployment. A fresh local test database is separate from the hosted allowance.
- Do not run the historical paid evaluation runners merely to reproduce a parser error. The included offline replay requires no account or API key.

The most useful next deliverable is a small held-out evaluation with separately measured retrieval coverage, writer structure validity, source-supported correctness, reviewer false acceptance/rejection, latency and cost. Fix the dominant measured failure while keeping exact reviewed answers and the original evidence unchanged.
