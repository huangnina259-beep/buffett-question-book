#!/usr/bin/env python3
"""Build server-only deferred original-context shards and a lexical source index.

Only derived files under lib/content/archive-* are written. The library is read
through the unchanged, read-only legacy retriever. No model or network is used.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter, defaultdict
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time


VERSION = "archive-context-search-1"


def encoded(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    started = time.perf_counter()
    root = args.repository.resolve()
    library = args.library.resolve()
    module_path = root / "legacy-retrieval/retrieval.py"
    spec = importlib.util.spec_from_file_location("archive_legacy_retrieval", module_path)
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    retriever = legacy.Retriever(library)
    if retriever.initialization_warnings:
        raise RuntimeError(f"Source initialization failed: {retriever.initialization_warnings}")
    original_fingerprint = dict(retriever.input_fingerprint)
    raw_checked = []
    for sid, source in sorted(retriever.sources.items()):
        if source.get("raw_archived"):
            if not retriever._raw_valid(sid):
                raise RuntimeError(f"Archived original hash mismatch: {sid}")
            raw_checked.append(sid)

    def canonical_unit(value: str | None, sid: str, paragraph: dict | None = None):
        if value in retriever.info:
            return value
        match = re.match(r"(.+-ch\d+)-p\d+$", value or "")
        if match and match.group(1) in retriever.info:
            return match.group(1)
        paragraph = paragraph or {}
        locator = paragraph.get("locator", {})
        physical_page = paragraph.get("physical_pdf_page") or locator.get("physical_pdf_page")
        if physical_page is not None:
            matches = [uid for uid in retriever.by_source[sid]
                       if retriever.info[uid]["locator"].get("type") == "pdf_page"
                       and retriever.info[uid]["locator"].get("page") == physical_page]
            if len(matches) == 1:
                return matches[0]
        return None

    contexts = {}
    unit_ids = {}
    origins = {}
    incomplete = {}
    text_checks = 0
    title_fallbacks = {}

    def english_editorial_title(value: str | None, sid: str, cid: str) -> str:
        """Keep English source headings; replace only absent/Chinese UI labels."""
        if value and not re.search(r"[\u3400-\u9fff]", value):
            return value
        source = retriever.sources[sid]
        year = source.get("year")
        kind = source.get("kind")
        known = {
            "berkshire-owner-manual": "Berkshire Hathaway Owner's Manual",
            "berkshire-buffett-thanksgiving-2025": "2025 Thanksgiving Shareholder Message and Berkshire Hathaway Announcement",
        }
        if sid in known:
            replacement = known[sid]
        elif kind == "shareholder_letter":
            replacement = f"{year} Shareholder Letter" if year else "Shareholder Letter"
        elif kind == "annual_meeting_session":
            session = re.search(r"-(morning|afternoon|part-\d+)$", sid)
            suffix = " — " + session.group(1).replace("-", " ").title() if session else ""
            replacement = (f"{year} " if year else "") + "Berkshire Hathaway Annual Meeting" + suffix
        else:
            labels = {"owners_manual": "Berkshire Hathaway Owner's Manual", "special_letter": "Special Shareholder Letter",
                      "shareholder_message": "Shareholder Message", "interview_transcript": "Interview Transcript",
                      "signed_article": "Signed Article"}
            if kind not in labels:
                raise RuntimeError(f"No safe English editorial title fallback for {sid}")
            replacement = (f"{year} " if year else "") + labels[kind]
        title_fallbacks[cid] = {"source_id": sid, "original_metadata_title": value,
                               "english_editorial_title": replacement}
        return replacement

    def normalize_legacy(context: dict) -> dict:
        nonlocal text_checks
        dates = context["dates"]
        event_date = dates.get("event_date")
        signature_date = dates.get("signature_date") or dates.get("signed_date")
        publication_date = dates.get("publication_date")
        date = event_date or signature_date or publication_date or dates.get("catalog_date")
        date_kind = ("event_date" if event_date else "signature_date" if signature_date else
                     "publication_date" if publication_date else "catalog_date" if date else
                     "report_year_only" if dates.get("report_year") is not None else "date_unresolved")
        paragraphs = []
        for paragraph in context["paragraphs"]:
            text = context["text"][paragraph["text_start"]:paragraph["text_end"]]
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != paragraph["returned_text_sha256"]:
                raise RuntimeError(f"Paragraph slice hash mismatch: {context['id']}:{paragraph['id']}")
            text_checks += 1
            basis = paragraph.get("attribution_basis")
            item = {"id": paragraph["id"], "speaker": paragraph.get("speaker"),
                    "text": text, "locator": paragraph.get("locator", {})}
            uid = canonical_unit(paragraph.get("source_unit_id"), context["source_id"], paragraph)
            if uid:
                item["unit_id"] = uid
            if basis is not None:
                item["speaker_basis"] = basis if isinstance(basis, str) else encoded(basis).decode("utf-8")
            # Candidate attribution never replaces a null canonical speaker.
            for key in ("candidate_speaker", "speaker_label", "author_attribution", "audio_checked", "applied_correction"):
                if paragraph.get(key) is not None:
                    item[key] = paragraph[key]
            paragraphs.append(item)
        return {"context_id": context["id"], "source_id": context["source_id"],
                "title": english_editorial_title(context.get("title") or context.get("source_title"), context["source_id"], context["id"]),
                "source_url": context["source_url"],
                "source_raw_sha256": context["source_raw_sha256"], "date": date,
                "date_kind": date_kind, "event_date": event_date, "signature_date": signature_date,
                "publication_date": publication_date, "report_year": dates.get("report_year"),
                "date_basis": {"catalog_year": dates.get("catalog_year"),
                               "catalog_date": dates.get("catalog_date"),
                               "source_date_basis": dates.get("date_basis"),
                               "date_note": dates.get("date_note")},
                "boundary": context["boundary"], "verification_scope": context["review_status"],
                "kind": context["kind"], "complete_within_boundary": True,
                "paragraphs": paragraphs}

    def add_legacy(context: dict | None) -> None:
        if context is None:
            return
        cid = context["id"]
        if not context["complete_within_boundary"] or context.get("omitted_units"):
            incomplete[cid] = {"id": cid, "source_id": context["source_id"],
                               "omitted_units": context.get("omitted_units", [])}
            return
        if cid in contexts:
            return
        contexts[cid] = normalize_legacy(context)
        unit_ids[cid] = sorted(context["unit_ids"])
        origins[cid] = "legacy_context"

    for uid in sorted(retriever.info):
        if uid not in retriever.excluded:
            add_legacy(retriever.context_for_unit(uid))
    for cid in sorted(retriever.reviewed):
        add_legacy(retriever.reviewed[cid])

    live_path = root / "lib/content/live-evidence-packets.json"
    live_bytes = live_path.read_bytes()
    live = json.loads(live_bytes)
    live_ids = []
    for original in live["contexts"]:
        cid, sid = original["context_id"], original["source_id"]
        if sid not in retriever.sources or not retriever._raw_valid(sid):
            raise RuntimeError(f"Live context has no hash-verified original: {cid}")
        expected_hash = original.get("raw_sha256") or original.get("source_raw_sha256")
        if expected_hash and expected_hash != retriever.sources[sid]["raw_sha256"]:
            raise RuntimeError(f"Live context source hash differs: {cid}")
        ids = set()
        for paragraph in original["paragraphs"]:
            candidates = [paragraph.get("source_unit_id"), paragraph.get("unit_id"),
                          paragraph.get("locator", {}).get("canonical_unit_id"), paragraph.get("id")]
            uid = next((matched for candidate in candidates
                        if (matched := canonical_unit(candidate, sid, paragraph))), None)
            if uid:
                ids.add(uid)
        if not ids:
            raise RuntimeError(f"No canonical unit mapping for live context: {cid}")
        if ids.intersection(retriever.excluded):
            raise RuntimeError(f"Live context includes excluded canonical units: {cid}")
        if cid in contexts:
            raise RuntimeError(f"Context id collision between legacy and live inputs: {cid}")
        # Preserve the selected live packet exactly, except its duplicate flat
        # context_text. Reading text, original text, dates and qualifiers remain.
        contexts[cid] = {key: value for key, value in original.items() if key != "context_text"}
        contexts[cid]["title"] = english_editorial_title(original.get("title"), sid, cid)
        unit_ids[cid] = sorted(ids)
        origins[cid] = "preserved_live_context"
        live_ids.append(cid)
    for cid, context in contexts.items():
        for companion in context.get("required_companion_context_ids", []):
            if companion not in contexts:
                raise RuntimeError(f"Missing required companion {companion} for {cid}")

    documents = []
    postings = defaultdict(list)
    shards = defaultdict(dict)
    for cid, context in sorted(contexts.items()):
        sid = context["source_id"]
        if not re.fullmatch(r"[a-z0-9_-]+", sid):
            raise RuntimeError(f"Unsafe source shard name: {sid}")
        body = "\n\n".join(p.get("reading_text", p["text"]) for p in context["paragraphs"])
        body_counts = Counter(legacy._tokens(body))
        title_counts = Counter(legacy._tokens(context["title"]))
        counts = body_counts.copy()
        for term, frequency in title_counts.items():
            counts[term] += 3 * frequency
        doc_index = len(documents)
        documents.append({"id": cid, "sourceId": sid, "title": context["title"],
                          "length": sum(counts.values()), "textCharacters": len(body),
                          "unitIds": unit_ids[cid], "complete": True,
                          "kind": context.get("kind", "preserved_live_context"), "shard": sid})
        for term, frequency in sorted(counts.items()):
            postings[term].extend([doc_index, frequency])
        shards[sid][cid] = context

    inputs = {"legacy_retriever_sha256": file_hash(module_path), "library": original_fingerprint,
              "live_packets_sha256": hashlib.sha256(live_bytes).hexdigest(),
              "live_bundle_hash": live.get("bundle_hash"),
              "verified_originals": {sid: retriever.sources[sid]["raw_sha256"] for sid in raw_checked}}
    summary = {"catalogSources": len(retriever.sources), "importedTextSources": sum(bool(s.get("unit_count")) for s in retriever.sources.values()),
               "servedSources": len(shards), "canonicalUnits": len(retriever.info), "excludedUnits": len(retriever.excluded),
               "acceptedPatches": len(retriever.patches), "reviewedLegacyContexts": len(retriever.reviewed),
               "incompleteContextsExcluded": len(incomplete), "preservedLiveContexts": len(live_ids),
               "contexts": len(documents), "indexTerms": len(postings)}
    index = {"version": VERSION, "scope": "Searchable eligible retained original contexts from the dated local archive plus selected existing live contexts; not all public material, a complete topic review, or blanket semantic approval.",
             "summary": summary, "documents": documents, "postings": dict(sorted(postings.items()))}
    bundle = hashlib.sha256(encoded({"version": VERSION, "inputs": inputs, "index": index}))
    for sid, shard in sorted(shards.items()):
        bundle.update(sid.encode("utf-8") + b"\0" + encoded(shard))
    index["bundle_hash"] = bundle.hexdigest()
    output = root / "lib/content"
    shard_dir = output / "archive-shards"
    shard_dir.mkdir(exist_ok=True, parents=True)
    files = []

    def write(path: Path, content: bytes) -> None:
        if not path.exists() or path.read_bytes() != content:
            path.write_bytes(content)
        files.append({"path": str(path.relative_to(root)), "bytes": len(content),
                      "gzip_bytes": len(gzip.compress(content, mtime=0)),
                      "sha256": hashlib.sha256(content).hexdigest()})

    write(output / "archive-index.json", encoded(index) + b"\n")
    imports, members = [], []
    gzip_roundtrips = 0
    decoded_shard_bytes = 0
    compressed_shard_bytes = 0
    for i, (sid, shard) in enumerate(sorted(shards.items())):
        json_bytes = encoded(shard)
        compressed = gzip.compress(json_bytes, compresslevel=9, mtime=0)
        # Use gzip's unspecified OS marker for identical headers across platforms.
        compressed = compressed[:9] + b"\xff" + compressed[10:]
        if gzip.decompress(compressed) != json_bytes:
            raise RuntimeError(f"Lossless compression roundtrip failed: {sid}")
        gzip_roundtrips += 1
        decoded_shard_bytes += len(json_bytes)
        compressed_shard_bytes += len(compressed)
        literal = json.dumps(base64.b64encode(compressed).decode("ascii"))
        module = ('/** Generated server-only original contexts. Lossless gzip; decode only on demand. */\n'
                  'import { gunzipSync } from "node:zlib";\n'
                  'import { Buffer } from "node:buffer";\n'
                  'export default () => JSON.parse(gunzipSync(Buffer.from(' + literal + ', "base64")).toString("utf8"));\n')
        write(shard_dir / (sid + ".ts"), module.encode("utf-8"))
        imports.append(f'import shard{i} from "./archive-shards/{sid}";')
        members.append(f'  {json.dumps(sid)}: shard{i},')
    factory_map = "/** Generated server-only factories; do not import into a client component. */\n" + "\n".join(imports)
    factory_map += "\nexport const archiveShards: Record<string, () => unknown> = {\n" + "\n".join(members) + "\n};\n"
    write(output / "archive-shards.ts", factory_map.encode("utf-8"))
    # Recheck immutable inputs after export rather than asserting immutability.
    for key, relative in (("catalog_sha256", "原文总目录.json"), ("database_sha256", "原文知识库.sqlite")):
        if file_hash(library / relative) != original_fingerprint[key]:
            raise RuntimeError("Canonical input changed during export")
    report = {"status": "exported_and_mechanically_checked", "version": VERSION,
              "bundle_hash": index["bundle_hash"], "summary": summary, "inputs": inputs,
              "verified_archived_originals": len(raw_checked), "legacy_paragraph_slice_hash_checks": text_checks,
              "served_paragraph_records_with_context_overlap": sum(len(c["paragraphs"]) for c in contexts.values()),
              "null_canonical_speaker_records_with_context_overlap": sum(p.get("speaker") is None for c in contexts.values() for p in c["paragraphs"]),
              "source_text_characters_with_context_overlap": sum(d["textCharacters"] for d in documents),
              "postings_pairs": sum(len(v) // 2 for v in postings.values()),
              "shard_representation": {"format": "deterministic gzip level 9 + base64; OS marker 255; mtime=0",
                  "decoded_shard_bytes": decoded_shard_bytes, "compressed_shard_bytes": compressed_shard_bytes,
                  "byte_equal_roundtrips": gzip_roundtrips, "bundle_hash_covers_decoded_payload_not_representation": True},
              "excluded_incomplete_contexts": list(incomplete.values()), "preserved_live_context_ids": live_ids,
              "english_editorial_title_fallbacks": title_fallbacks,
              "required_companions": {cid: c["required_companion_context_ids"] for cid, c in contexts.items() if c.get("required_companion_context_ids")},
              "output_bytes": sum(f["bytes"] for f in files), "output_gzip_bytes_sum": sum(f["gzip_bytes"] for f in files),
              "under_64_MiB_source_output": sum(f["bytes"] for f in files) < 64 * 1024 * 1024,
              "files": files, "elapsed_seconds": round(time.perf_counter() - started, 3),
              "limitations": ["Export validation preserves source text, metadata and exclusions; it does not establish answer support or semantic search quality.",
                              "Publisher chapters can have delayed follow-ups; PDF windows are bounded page windows, not authenticated complete Q&A.",
                              "Do not parse all shard factories eagerly or cache all parsed contexts in a Worker isolate.",
                              "Runtime must retain required companions atomically and expose insufficient evidence honestly.",
                              "The full production bundle and peak concurrent-request memory still require runtime verification."]}
    if args.report:
        args.report.parent.mkdir(exist_ok=True, parents=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "bundle_hash", "summary", "output_bytes", "output_gzip_bytes_sum", "under_64_MiB_source_output", "elapsed_seconds")}, indent=2))


if __name__ == "__main__":
    main()
