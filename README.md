# Buffett Question Book — review handoff

**Status: the current website is a private prototype with unreliable free-form answering. This repository preserves the failure for independent engineering review; it is not a completed fix.**

Start with [the engineering handoff](HANDOFF.md) and [the review request](docs/REVIEW-REQUEST.md). Application source comes from Site commit `58bca6e0857e898c453261e01956be51e2a17c5f` (live version 5 when exported, 2026-11-05). The original seven-commit application history is retained.

## The failure to reproduce

`how to be a great investor` returns no source contexts in the hosted application's router. The included local archive retriever finds relevant originals for the same question. The website currently uses fixed phrases over **19 selected contexts**; it does not search the full archive. Its seven prepared answers use a separate exact-match path and therefore do not prove that free-form answering works.

Independent retrieval diagnostics also expose paraphrase misses, irrelevant keyword matches and incorrect inheritance of a previous topic. A second AI source-support check does not repair missing retrieval and has missed unsupported generated claims. See [retrieval evidence and fixtures](diagnostics/retrieval/README.md) and [the recorded version-5 review](diagnostics/release-v5/v5-independent-review.json).

## Reproduce without an API key

Use **Node.js 24 LTS**, npm, and **Python 3.10+ with SQLite FTS5**. Installing Node dependencies may access the package registry; the following diagnostics make no model calls.

```sh
npm ci --no-audit --no-fund
node diagnostics/run-offline.mjs
node diagnostics/retrieval/audit-run.mjs
python3 scripts/restore-library.py
PYTHONDONTWRITEBYTECODE=1 python3 legacy-retrieval/test_retrieval.py
python3 legacy-retrieval/retrieval.py data/library "how to be a great investor" --limit 4 --budget-chars 65000
```

The last command prints original contexts and provenance, not an AI-written answer. The independent retrieval audit deliberately includes known failures; its output is a diagnostic baseline, not a passing product-quality score. Generated test reports belong in ignored `test-results/`.

For the local UI, build, D1 initialization and opt-in model configuration, follow [HANDOFF.md](HANDOFF.md). `.env.example` has a blank key and generation disabled. The app uses **Vinext/Vite and a Cloudflare Worker with D1**, rather than a conventional `next start` deployment. A GitHub checkout or GitHub Pages publication alone does not supply its backend.

## Repository map

| Path | Purpose |
| --- | --- |
| `app/`, `lib/`, `db/`, `worker/`, `drizzle/` | Current website UI, request flow, lexical router, writer/reviewer, persistence and migrations |
| `HANDOFF.md`, `docs/REVIEW-REQUEST.md` | Actual behavior, failures, setup, code entry points and questions for the reviewer |
| `diagnostics/` | Portable mocked backend/parser/transport tests, immutable saved-output fixtures and dated observations |
| `diagnostics/retrieval/` | Independent source-anchored diagnostic questions and reproducible known failures |
| `legacy-retrieval/` | Existing read-only Python full-text retriever, tests and corpus-scope explanation |
| `data/library/` | 150 archived publisher files, canonical metadata, corrections and a compressed original-source database |
| `data/library-manifest.json` | Exact corpus transport allowlist, sizes, SHA-256 hashes and documented omissions |
| `legacy-app/` | Earlier local Python/Codex app, for architectural comparison; not the hosted backend |
| `docs/SITE-README.original.md` | Original historical Site README, retained for provenance; HANDOFF is the current guide |

## Data and boundaries

The catalog has **151 source records, 150 archived files and 118 sources with extracted body text**. The database has 6,313 units and 6,297 rows in its default FTS index; additional extraction/quality exclusions remain in the retriever. These numbers do not mean that the complete Buffett archive or all source meanings have been verified.

The exact 113.7 MB SQLite file is transported as a 16.7 MB gzip file and restored locally with SHA-256 verification. The restored database is ignored by Git. No LFS setup or original machine path is needed. The [corpus guide](legacy-retrieval/README.txt) identifies optional historical catalog links not included in this runtime subset.

Live API keys, browser cookies, visitor sessions, user-feedback databases, dependency folders and local runtime state are excluded. Deliberate diagnostic question strings and saved experimental model outputs remain for reproduction. Publishing this repository does not deploy or alter the existing website. The full archive is not automatically connected to the app by being present under `data/`.

The private review snapshot does not grant a new redistribution license to third-party original texts. Their ownership and existing dependency notices are retained.
