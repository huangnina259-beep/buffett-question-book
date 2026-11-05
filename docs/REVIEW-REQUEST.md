# Independent review request

Please reproduce the failure before proposing changes. This repository is an engineering review snapshot, not a working general-purpose Q&A release.

## Required outcomes

1. Explain why `how to be a great investor` returns no evidence in the hosted path while the included local archive contains relevant passages.
2. Compare `lib/retrieved-evidence.ts` with `legacy-retrieval/retrieval.py`. Identify what is needed to connect the eligible archive to the deployed runtime without losing dates, attribution, exclusions or complete-context boundaries.
3. Test unseen paraphrases, irrelevant queries, genuine follow-ups and explicit topic changes. Do not use the seven prepared answers as evidence that free-form retrieval works.
4. Independently inspect generated claims against original sources. Distinguish citation/format validity from substantive support, and measure false approvals and false rejections by the second model.
5. Separate retrieval failures, provider failures, output parsing, review rejection, timeout and permanent-budget exhaustion. Recommend the smallest demonstrable repair before a redesign.
6. Specify reproducible local setup and a deployable backend. A GitHub repository or static frontend does not itself provide model inference, D1 storage or access control.

## Existing evidence

- Current app lineage: original Site commit `58bca6e0857e898c453261e01956be51e2a17c5f` (live version 5 at the time of export).
- `diagnostics/retrieval/` contains source-anchored diagnostic fixtures and known failing outcomes, not a measured production error rate.
- `diagnostics/release-v5/` contains historical functional and independent source-review observations. Successful delivery and semantic correctness are separate.
- `HANDOFF.md` describes current code paths, budgets and local setup.
- `legacy-app/` preserves the earlier local Python/Codex application for comparison only. It is not the website's backend, requires separate account setup, and its full pipeline has not been validated by this handoff. Do not start it merely to reproduce retrieval.

## Scope of this handoff

The current website code is preserved. New material is documentation, portable diagnostics and a read-only archive/retrieval package. No fix to free-form answering is claimed here. No live credentials, browser sessions, visitor database or provider-account exports are included. The few question strings in diagnostics are deliberate reproduction examples.

The original collection contains third-party texts. This private review handoff does not grant a new redistribution license to those materials. Existing code dependency notices remain in place.
