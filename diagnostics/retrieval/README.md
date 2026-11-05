# Retrieval diagnosis and reproducible baseline

This is an independent diagnostic audit of the inherited router, not a passing test suite or an estimate of production error rates. The fixture set contains 89 hand-selected, source-anchored cases: natural English paraphrases, unrelated controls, continuations, topic changes, multi-topic requests and separately reported Chinese language probes. Expectations were authored before running the router, after reading its implementation and the relevant originals; this is not a blind benchmark.

The exact question `how to be a great investor` is a user-provided reproduction case. No other visitor questions, sessions, cookies, credentials or application database records are included. Other questions are authored diagnostic fixtures. Source excerpts are original-library material, not generated answers.

## Run without model calls

After installing the repository dependencies, run from the project root:

```sh
node diagnostics/retrieval/audit-run.mjs
```

The runner bundles and executes the actual `lib/retrieved-evidence.ts` with the local `esbuild` dependency. It does not load `.env` files, start a server, contact a provider, or run inference. No credentials are needed. All source resolution is relative to this repository; the current working directory does not matter.

Generated output goes to the ignored `test-results/retrieval/audit-results.json`. The committed baseline at `diagnostics/retrieval/audit-results.json` is never overwritten. A zero exit status means the diagnostic completed, not that the router meets its acceptance criteria. The summary shows both acceptance failures and whether current outputs reproduce the known baseline.

## Files and interpretation

- `audit-fixtures.json`: source-family expectations and the 89 questions.
- `audit-results.json`: immutable baseline produced against the inherited source hashes recorded inside it.
- `audit-findings.json`: mechanisms, scope, recommendations and acceptance criteria.
- `audit-user-question-source-basis.json`: original paragraphs supporting the relevance of the exact user reproduction question. Unknown speaker attribution remains unknown.
- `audit-run.mjs`: portable runner. Its pass/fail judgment uses the real router output. The explanatory trace separately mirrors the old lexical ranking and must be revised or removed if the router design changes.

The baseline contains 23 passing and 66 failing diagnostic cases. For standalone in-scope English questions, 13 of 58 retrieved the minimum expected source family; 44 returned no evidence and one returned the wrong family. These counts deliberately expose weaknesses and must not be presented as a real-user accuracy rate.

The core finding is that the current fixed phrase router misses relevant passages already included in its own evidence packet. Replacing a writing model alone does not fix that. The audit does not establish answer quality, full-corpus coverage, hosted reliability or a deployed repair. Keep this baseline when improving retrieval, and add independently authored held-out cases before making broader reliability claims.
