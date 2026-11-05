Local archive retrieval for collaborator review

This directory is a read-only search/debugging companion to the website at the
repository root. It does not enable broader archive retrieval in the hosted app.
It requires Python 3.10 or newer with SQLite FTS5 and no third-party packages,
model service, API key, network connection or original collection directory.

From the repository root:

  python3 scripts/restore-library.py
  PYTHONDONTWRITEBYTECODE=1 python3 legacy-retrieval/test_retrieval.py
  python3 legacy-retrieval/retrieval.py data/library "index funds" --limit 4 --budget-chars 24000

The first command verifies every manifest-listed file, restores the compressed
database, checks its original SHA-256 and runs SQLite quick_check. Running it
again verifies an existing matching database. It refuses to overwrite a changed
database. Do not commit the restored .sqlite file or its sidecar files; the
tracked .sqlite.gz is the lossless transport snapshot.

Included data

- All 150 catalogued archived original files, unchanged, with source URLs and
  original SHA-256 hashes. The catalog contains 151 sources; one has no archived
  file. Only 118 sources have extracted body text. Archived reference pages and
  unavailable text are not promoted into answer evidence.
- The canonical SQLite database: 6,313 original/reading-text units, attribution,
  date/locator metadata, quality flags and the original FTS index. Source and
  search exclusion flags are unchanged.
- The six accepted extraction repairs, six reviewed context packets, 215 logical
  HTML sections and their small supporting manifests/review records. Repairs are
  applied by the retriever as separate checked derivations; originals stay intact.
- data/library-manifest.json: the exact allowlist, sizes, hashes, known omissions
  and the runtime's current exclusion counts.

retrieval.py is byte-identical to the prior local retriever. The test file has
one adapted library-path line; its historical header command is retained from
the original. Use the commands above in this repository.

What the result means

The returned packet selects complete retained contexts within a character budget;
it does not generate an answer. Original text for each paragraph is the slice
context['text'][paragraph['text_start']:paragraph['text_end']]. local_source_url is
URL-encoded relative to data/library. Resolve it against your own library route.
Source hashes, source exclusions, unknown attribution and historical dates remain
available for inspection. Current search is lexical, with limited normalization;
the caller can provide additional English search variants. This is not a semantic
ranking guarantee and does not make an arbitrary source passage reviewed.

The eight tests check preservation, accepted corrections, provenance, read-only
access, whole-context budgets and explicit query failures. They are not a claim
that all source text or generated answers have been semantically verified.

Scope and omitted files

This is the minimum runtime corpus plus bounded provenance, not the full old
reader website. Catalog metadata is preserved byte-for-byte, so optional reader,
text_units, alternate-edition and historical-review pointers may refer to files
outside this subset. Seven historical absolute metadata path fields remain for
provenance; none is used by the retriever. All active raw_path references are
portable and resolve within data/library.

The redundant 83 MB JSONL export, duplicate library, old reader HTML, private user
questions, runtime logs, provider traces, API keys and local configuration are
omitted. This corpus is a dated collection snapshot with explicit gaps; it is not
all of Buffett's public material. Archived publisher materials retain their
original ownership; this package does not grant new redistribution rights.

The compressed database stays below GitHub's 100 MiB per-file limit. The combined
raw-file size is not a single-file violation; every raw file is below 2.5 MB.
Exact measured sizes and the official GitHub documentation link are in the
manifest. Website deployment should not bundle this local corpus automatically.
