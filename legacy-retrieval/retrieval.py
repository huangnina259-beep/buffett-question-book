"""Read-only, source-first retrieval for the local Buffett Q&A experiment.

Usage::
    retriever = Retriever(library_path)
    packet = retriever.search(question, queries=["English search variants"],
                              limit=8, budget_chars=65000)

`selected_contexts` contains complete retained boundaries, never clipped text.
Each context's paragraph text is `context['text'][p['text_start']:p['text_end']]`.
`local_source_url` is URL-encoded relative to the supplied library root; callers
must resolve it against their library-serving route. No external services,
embeddings, answer files, evaluation files, or original-source mutations are used.
The budget counts source text, not JSON metadata. Selection is research retrieval,
not independent semantic approval of previously unreviewed corpus passages.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
from typing import Any
from urllib.parse import quote


STOP = set("a an the and or for of to in on with from by as at is are was were be been being it its this that these those i you your we our he his they their them do does did can could would should may might will what which how why when where who than then about into over have has had not no if but so all any some more most much many very also just really tell say said says think thoughts please explain according warren buffett charlie munger".split())


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _tokens(text: str) -> list[str]:
    result = []
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        if word in STOP or len(word) < 2:
            continue
        # A deliberately small lexical normalization, not a semantic synonym map.
        if len(word) > 5 and word.endswith("ies"):
            word = word[:-3] + "y"
        elif len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        result.append(word)
    return result


class Retriever:
    def __init__(self, library_path: str | Path):
        self.library = Path(library_path).resolve()
        self.database = self.library / "原文知识库.sqlite"
        if not self.database.is_file():
            raise FileNotFoundError(self.database)
        self.catalog = self._json(self.library / "原文总目录.json")
        self.sources = {s["id"]: s for s in self.catalog["sources"]}
        self.info: dict[str, dict] = {}
        self.by_source: dict[str, list[str]] = defaultdict(list)
        self.excluded: dict[str, list[str]] = {}
        self.patches: dict[str, dict] = {}
        self.reviewed: dict[str, dict] = {}
        self.unit_to_reviewed: dict[str, list[str]] = defaultdict(list)
        self.html_sections: dict[str, dict] = {}
        self.unit_to_section: dict[str, str] = {}
        self.initialization_warnings: list[str] = []
        with self._connection() as conn:
            for row in conn.execute("SELECT id,source_id,ordinal,metadata_json FROM units ORDER BY source_id,ordinal"):
                meta = json.loads(row["metadata_json"])
                uid = row["id"]
                self.info[uid] = {"id": uid, "source_id": row["source_id"],
                                  "ordinal": row["ordinal"], "locator": meta.get("locator", {})}
                self.by_source[row["source_id"]].append(uid)
                reasons = []
                source = self.sources.get(row["source_id"], {})
                if not source.get("unit_count") or not source.get("raw_archived"):
                    reasons.append("source_has_no_archived_body")
                if source.get("kind") in {"interview_candidate", "speech_candidate"}:
                    reasons.append("reference_only_source")
                if source.get("third_party_transcription") or source.get("unverified_transcript"):
                    reasons.append("unverified_third_party_transcription")
                if meta.get("duplicate_of"):
                    reasons.append("confirmed_duplicate")
                if meta.get("default_search_eligible") is False:
                    reasons.append("default_search_ineligible")
                if meta.get("non_whitespace_control_character_count", 0):
                    reasons.append("unresolved_control_characters")
                if meta.get("extraction_alerts"):
                    reasons.append("unresolved_extraction_alerts")
                if meta.get("quality", {}).get("known_layout_defect"):
                    reasons.append("known_layout_defect")
                if reasons:
                    self.excluded[uid] = reasons
        self._load_accepted_patches()
        self._load_reviewed_contexts()
        self._load_html_sections()
        self.extra_search = {}
        for key, context in self.reviewed.items():
            self.extra_search[key] = Counter(_tokens(context["text"]))
        for uid, patch in self.patches.items():
            self.extra_search["patch:" + uid] = Counter(_tokens(patch["text"]))
        self.input_fingerprint = {
            "catalog_sha256": _sha(self.library / "原文总目录.json"),
            "database_sha256": _sha(self.database),
            "qa_pilot_manifest_sha256": self._optional_sha("qa-pilot/manifest.json"),
            "reviewed_core_manifest_sha256": self._optional_sha("reviewed-core/manifest.json"),
        }

    @staticmethod
    def _json(path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8"))

    def _connection(self):
        uri = self.database.as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def _path(self, value: str, base: Path | None = None) -> Path:
        path = ((base or self.library) / value).resolve()
        if not path.is_relative_to(self.library):
            raise ValueError("Source path leaves the library root")
        return path

    def _optional_sha(self, rel: str):
        path = self.library / rel
        return _sha(path) if path.is_file() else None

    @lru_cache(maxsize=96)
    def _unit(self, uid: str) -> dict:
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone()
        if row is None:
            raise KeyError(uid)
        unit = json.loads(row["metadata_json"])
        unit.update(id=row["id"], source_id=row["source_id"], ordinal=row["ordinal"],
                    text=row["text"], reading_text=row["reading_text"],
                    locator=json.loads(row["locator_json"]))
        return unit

    @lru_cache(maxsize=160)
    def _raw_valid(self, sid: str) -> bool:
        source = self.sources.get(sid, {})
        try:
            path = self._path(source["raw_path"])
            return path.is_file() and _sha(path) == source["raw_sha256"]
        except (KeyError, TypeError, ValueError, OSError):
            return False

    def _load_accepted_patches(self):
        folder = self.library / "reviewed-core/corrections"
        if not (folder / "acceptance.json").is_file():
            return
        acceptance = self._json(folder / "acceptance.json")
        manifest_path = folder / "corrections.json"
        if acceptance.get("status") != "independently_reviewed_extraction_repairs":
            return
        if _sha(manifest_path) != acceptance.get("producer_manifest_sha256"):
            self.initialization_warnings.append("Accepted correction manifest hash mismatch; no patches applied.")
            return
        manifest = self._json(manifest_path)
        for patch in manifest.get("patches", []):
            uid = patch.get("unit_id")
            if uid not in self.info or patch["patch_id"] not in acceptance.get("patch_ids", []):
                continue
            try:
                unit = self._unit(uid)
                assert self._raw_valid(unit["source_id"])
                assert _text_sha(unit["text"]) == patch["base_text_sha256"]
                assert unit["source_raw_sha256"] == patch["source_raw_sha256"]
                text = unit["text"]
                for op in sorted(patch["operations"], key=lambda x: x["start"], reverse=True):
                    assert text[op["start"]:op["end_exclusive"]] == op["before"]
                    text = text[:op["start"]] + op["after"] + text[op["end_exclusive"]:]
                assert _text_sha(text) == patch["derived_text_sha256"]
            except (KeyError, AssertionError):
                self.initialization_warnings.append(f"Patch {patch.get('patch_id')} failed preservation checks and was excluded.")
                continue
            self.patches[uid] = {"text": text, "patch_id": patch["patch_id"],
                                 "manifest": "reviewed-core/corrections/corrections.json",
                                 "acceptance": "reviewed-core/corrections/acceptance.json",
                                 "answer_eligibility_granted": False,
                                 "derived_text_sha256": patch["derived_text_sha256"]}
            # The quarantined ORIGINAL stays excluded; an accepted replacement may
            # enter retrieval. Duplicate suppression can never be overridden.
            remaining = [reason for reason in self.excluded.get(uid, []) if reason not in {
                "default_search_ineligible", "unresolved_control_characters",
                "unresolved_extraction_alerts", "known_layout_defect"}]
            if remaining:
                self.excluded[uid] = remaining
            else:
                self.excluded.pop(uid, None)

    def _load_reviewed_contexts(self):
        groups = defaultdict(list)
        for rel in ("reviewed-core/evidence.json", "qa-pilot/evidence.json"):
            evidence_path = self.library / rel
            if not evidence_path.exists():
                continue
            for claim in self._json(evidence_path).get("claims", []):
                if not claim.get("eligible_as_answer_evidence"):
                    continue
                if not claim.get("context_path"):
                    continue
                try:
                    path = self._path(claim["context_path"], evidence_path.parent)
                except ValueError:
                    continue
                groups[path].append(claim)
        for path, claims in groups.items():
            if not path.is_file():
                continue
            data = self._json(path)
            sid = data.get("source_id")
            if not sid or not self._raw_valid(sid):
                self.initialization_warnings.append(f"Reviewed context {path.name} has no matching archived original and was excluded.")
                continue
            if data.get("source_raw_sha256") != self.sources[sid].get("raw_sha256"):
                continue
            if any(c.get("context_sha256") and c["context_sha256"] != _sha(path) for c in claims):
                self.initialization_warnings.append(f"Reviewed context {path.name} no longer matches its claim hash and was excluded.")
                continue
            source_ids = set(data.get("source_unit_ids", []))
            if data.get("source_unit_id"):
                source_ids.add(data["source_unit_id"])
            for paragraph in data.get("paragraphs", []):
                for uid in (paragraph.get("source_unit_id"), paragraph.get("id"),
                            paragraph.get("locator", {}).get("canonical_unit_id")):
                    if uid in self.info:
                        source_ids.add(uid)
                match = re.match(r"(.+-ch\d+)-p\d+$", paragraph.get("id", ""))
                if match and match.group(1) in self.info:
                    source_ids.add(match.group(1))
            if any(uid in self.excluded for uid in source_ids):
                self.initialization_warnings.append(f"Reviewed context {data['id']} includes an excluded unit; it was not promoted.")
                continue
            context = self._packet(data["id"], sid, data.get("title", ""), data.get("paragraphs", []),
                                   sorted(source_ids), data.get("boundary", "Complete reviewed source context."),
                                   "reviewed_context", data.get("locator", {}))
            context["dates"].update({k: data[k] for k in ("report_year", "event_date", "signed_date", "signature_date", "publication_date", "date_basis", "date_note") if k in data})
            context["context_file_url"] = quote(str(path.relative_to(self.library)), safe="/")
            context["context_sha256"] = _sha(path)
            context["review_status"] = "Selected claims reviewed; surrounding context is not blanket semantic approval."
            unique = {c["id"]: c for c in claims}
            context["editorial_annotations"] = {"kind": "reviewed_claim_metadata_not_source_quotation",
                "claims": [{k: c.get(k) for k in ("id", "kind", "speaker", "statement_en", "paragraph_ids", "conditions_en", "does_not_support_en", "review_status")} for c in unique.values()]}
            self.reviewed[context["id"]] = context
            for uid in source_ids:
                self.unit_to_reviewed[uid].append(context["id"])

    def _load_html_sections(self):
        directory = self.library / "readability/html"
        if not directory.is_dir():
            return
        for path in sorted(directory.glob("*.json")):
            try:
                data = self._json(path)
            except (ValueError, OSError):
                continue
            sid = data.get("source_id")
            if sid not in self.sources or data.get("source_raw_sha256") != self.sources[sid].get("raw_sha256"):
                continue
            for section in data.get("sections", []):
                ids = section.get("source_unit_ids", [])
                if not ids or any(uid not in self.info for uid in ids):
                    continue
                key = "section:" + section["id"]
                self.html_sections[key] = {"source_id": sid, "title": section.get("title", ""),
                                            "unit_ids": ids, "locator": section.get("locator", {})}
                for uid in ids:
                    self.unit_to_section[uid] = key

    def _source_meta(self, sid: str) -> dict:
        source = self.sources[sid]
        return {"source_id": sid, "source_title": source.get("title"),
                "source_kind": source.get("kind"), "source_url": source.get("url"),
                "local_source_url": quote(source.get("raw_path") or "", safe="/"),
                "local_url_basis": "Relative to library root, not the experiment server route.",
                "source_raw_path": source.get("raw_path"), "source_raw_sha256": source.get("raw_sha256"),
                "dates": {"catalog_year": source.get("year"),
                          "report_year": source.get("year") if source.get("kind") == "shareholder_letter" else None,
                          "event_date": source.get("date") if source.get("kind") == "annual_meeting_session" or source.get("date_basis") == "live_appearance_date_explicit_on_first_page" else None,
                          "catalog_date": source.get("date"), "date_basis": source.get("date_basis"),
                          "publication_date": source.get("publication_date"),
                          "signed_date": source.get("signed_date"),
                          "date_note": source.get("date_note")},
                "source_quality": {"publisher_transcript_status": source.get("publisher_transcript_status"),
                                   "quality": source.get("quality", {}), "issues": source.get("issues", []),
                                   "full_semantic_review_completed": source.get("full_semantic_review_completed", False)}}

    def _packet(self, cid, sid, title, paragraphs, unit_ids, boundary, kind, locator):
        text_parts, metas, offset = [], [], 0
        for p in paragraphs:
            text = p.get("reading_text") or p.get("text") or p.get("text_as_received") or ""
            if not text:
                continue
            text_parts.append(text)
            source_unit_id = p.get("source_unit_id") or p.get("locator", {}).get("canonical_unit_id")
            if not source_unit_id and p.get("id") in self.info:
                source_unit_id = p["id"]
            if not source_unit_id:
                match = re.match(r"(.+-ch\d+)-p\d+$", p.get("id", ""))
                if match and match.group(1) in self.info:
                    source_unit_id = match.group(1)
            meta = {"id": p.get("id"), "text_start": offset, "text_end": offset + len(text),
                    "locator": p.get("locator", {}), "source_unit_id": source_unit_id,
                    "speaker": p.get("canonical_speaker"), "candidate_speaker": p.get("candidate_speaker"),
                    "speaker_label": p.get("speaker_label"), "attribution_basis": p.get("attribution_basis") or p.get("attribution"),
                    "author_attribution": p.get("author_attribution"), "kind": p.get("kind") or p.get("unit_kind"),
                    "source_text_sha256": p.get("text_sha256"),
                    "returned_text_sha256": _text_sha(text),
                    "reversible_encoding_repairs": p.get("reversible_encoding_repairs", [])}
            for key in ("speaker_name_label", "speaker_label_kind", "contextual_speaker_label",
                        "publisher_attributes", "semantic_review", "audio_checked", "speaker_confidence",
                        "speaker_attribution_confidence"):
                if key in p:
                    meta[key] = p[key]
            if p.get("applied_correction"):
                meta["applied_correction"] = p["applied_correction"]
            metas.append(meta)
            offset += len(text) + 2
        result = self._source_meta(sid)
        result.update(id=cid, title=title, title_kind="Source/publisher title or identified editorial grouping; not a speaker quotation.",
                      kind=kind, text="\n\n".join(text_parts), paragraphs=metas,
                      unit_ids=list(unit_ids), locator=locator, boundary=boundary,
                      complete_within_boundary=True, truncated=False,
                      omitted_units=[], editorial_annotations={},
                      review_status="Source extraction; complete semantic and audio review not established.")
        result["source_text_chars"] = len(result["text"])
        return result

    def _unit_paragraphs(self, uid):
        unit = self._unit(uid)
        if uid in self.patches:
            patch = self.patches[uid]
            return [{"id": uid, "text": patch["text"], "source_unit_id": uid,
                     "locator": unit["locator"], "author_attribution": unit.get("author_attribution"),
                     "text_sha256": unit.get("text_sha256"),
                     "applied_correction": {k: v for k, v in patch.items() if k != "text"},
                     "attribution_basis": "Page extraction; no page-wide speaker inferred."}]
        if unit.get("paragraphs"):
            return unit["paragraphs"]
        return [{"id": uid, "source_unit_id": uid, "text": unit["text"],
                 "reading_text": unit.get("reading_text"), "locator": unit["locator"],
                 "author_attribution": unit.get("author_attribution"),
                 "text_sha256": unit.get("text_sha256"), "unit_kind": unit.get("unit_kind"),
                 "attribution_basis": "Original unit metadata only; no speaker inferred from document title."}]

    def context_for_unit(self, unit_id: str, prefer_reviewed: bool = True):
        """Get an eligible complete boundary for a canonical unit, or None.

        This optional follow-up API does not bypass exclusions. A caller can
        expand a candidate_pool unit_id without repeating lexical ranking.
        """
        if unit_id not in self.info:
            return None
        return self._expand(unit_id, prefer_reviewed=prefer_reviewed)

    def _expand(self, uid: str, prefer_reviewed: bool = True):
        if uid in self.excluded:
            return None
        info = self.info[uid]; sid = info["source_id"]
        if not self._raw_valid(sid):
            return None
        unit = self._unit(uid)
        # A reviewed meeting context may join an answer with its next chapter's
        # qualification. Do not substitute the smaller chapter if that whole
        # context is later omitted for budget. PDF reviewed sections can cover
        # only part of a page, so their adjoining page windows remain candidates.
        reviewed_ids = self.unit_to_reviewed.get(uid, [])
        if prefer_reviewed and reviewed_ids and unit.get("unit_type") == "publisher_chapter":
            return self.reviewed[reviewed_ids[0]]
        omitted = []
        if unit.get("unit_type") == "publisher_chapter":
            chosen = [uid]
            cid = "chapter:" + uid
            title = unit.get("title", "")
            kind = "complete_publisher_chapter"
            boundary = "Whole publisher Q&A chapter, including questions and all labelled and unlabelled paragraphs. Other chapters may contain delayed follow-ups; they are not silently assumed included."
            locator = unit["locator"]
        elif uid in self.unit_to_section:
            cid = self.unit_to_section[uid]; sec = self.html_sections[cid]
            chosen = sec["unit_ids"]
            title, locator = sec["title"], sec["locator"]
            kind = "complete_html_letter_section"
            boundary = "Whole logical section identified by the existing source-linked HTML reading structure. Text comes from canonical units, not editorial summaries."
        else:
            ordered = self.by_source[sid]; at = ordered.index(uid)
            radius = 1 if unit["locator"].get("type") == "pdf_page" or unit.get("unit_kind") == "pdf_page" else 3
            chosen = ordered[max(0, at-radius):min(len(ordered), at+radius+1)]
            cid = "window:" + sid + ":" + chosen[0] + ":" + chosen[-1]
            title = self.sources[sid].get("title", "")
            kind = "pdf_page_with_adjacency" if radius == 1 else "source_blocks_with_adjacency"
            boundary = "Complete matched page plus one available page on each side; this is a bounded page window, not a complete letter/interview or authenticated complete Q&A." if radius == 1 else "Matched canonical block with up to three adjacent blocks each side; no reliable logical-section mapping was available."
            locator = {"matched_unit": uid, "included_original_locators": [self.info[x]["locator"] for x in chosen]}
        kept = []
        for candidate in chosen:
            if candidate in self.excluded:
                omitted.append({"unit_id": candidate, "reason": self.excluded[candidate]})
            else:
                kept.append(candidate)
        # An entire logical section with a missing unit is not silently promoted
        # as a complete section. Return its explicit gap status for the caller.
        paragraphs = [p for candidate in kept for p in self._unit_paragraphs(candidate)]
        result = self._packet(cid, sid, title, paragraphs, kept, boundary, kind, locator)
        result["omitted_units"] = omitted
        result["complete_within_boundary"] = not omitted
        if omitted:
            result["boundary"] += " One or more ineligible units were omitted; see omitted_units."
        return result

    @staticmethod
    def _lexical_score(text: str, queries: list[list[str]]) -> float:
        counts = Counter(_tokens(text)); length = max(1, sum(counts.values()))
        scores = []
        for tokens in queries:
            unique = set(tokens)
            if not unique:
                continue
            present = unique.intersection(counts)
            coverage = len(present) / len(unique)
            density = sum(min(counts[w], 5) for w in present) / (1 + math.log1p(length))
            scores.append(coverage * coverage * 3 + density * .15)
        return max(scores, default=0) + sum(sorted(scores, reverse=True)[1:3]) * .12

    def search(self, query: str, queries=None, limit: int = 8, budget_chars: int = 65000) -> dict:
        if not isinstance(query, str):
            raise TypeError("query must be a string")
        if queries is None:
            queries = []
        if not isinstance(queries, (list, tuple)) or any(not isinstance(q, str) for q in queries):
            raise TypeError("queries must contain strings supplied by the caller")
        limit = max(1, min(int(limit), 20)); budget_chars = max(0, min(int(budget_chars), 200000))
        variants = list(dict.fromkeys(q.strip()[:600] for q in [query, *queries] if q.strip()))[:9]
        qtokens = [list(dict.fromkeys(_tokens(q)))[:20] for q in variants]
        ranking, matched = defaultdict(float), defaultdict(set)
        fts_errors = []
        with self._connection() as conn:
            for qi, tokens in enumerate(qtokens):
                if not tokens:
                    continue
                expression = " OR ".join('"' + t + '"' + ('*' if len(t) >= 4 else '') for t in tokens)
                try:
                    rows = conn.execute("SELECT unit_id,bm25(unit_search,0,0,1.4,1) AS rank FROM unit_search WHERE unit_search MATCH ? ORDER BY rank LIMIT 100", (expression,)).fetchall()
                except sqlite3.Error as exc:
                    fts_errors.append(str(exc)); continue
                for i, row in enumerate(rows, 1):
                    uid = row["unit_id"]
                    if uid in self.info and uid not in self.excluded:
                        ranking[uid] += 1 / (60+i)
                        matched[uid].add(qi)
        contexts, context_rrf, context_queries = {}, defaultdict(float), defaultdict(set)
        # Additional reviewed contexts and accepted corrections are searched on
        # source text, never on claim paraphrases or authored pilot answers.
        for key, counts in self.extra_search.items():
            score = max((len(set(t).intersection(counts))/max(1,len(t)) for t in qtokens), default=0)
            if not score:
                continue
            if key.startswith("patch:"):
                uid = key[6:]; ranking[uid] = max(ranking[uid], .018 * score)
            else:
                contexts[key] = self.reviewed[key]
        for uid in sorted(ranking, key=ranking.get, reverse=True)[:180]:
            expanded = self._expand(uid)
            if expanded:
                cid = expanded["id"]; contexts[cid] = expanded
                context_rrf[cid] = max(context_rrf[cid], ranking[uid])
                context_queries[cid].update(matched[uid])
            for cid in self.unit_to_reviewed.get(uid, []):
                contexts[cid] = self.reviewed[cid]
                context_rrf[cid] = max(context_rrf[cid], ranking[uid])
                context_queries[cid].update(matched[uid])
        scored = []
        for cid, ctx in contexts.items():
            lex = self._lexical_score(ctx["text"], qtokens)
            if lex <= 0:
                continue
            score = lex + context_rrf[cid] * 16
            if ctx["kind"] == "reviewed_context":
                score *= 1.15
            if ctx["omitted_units"]:
                score *= .6
            scored.append((score, cid, ctx))
        scored.sort(key=lambda row: (-row[0], row[1]))
        selected, candidates, omitted, used, seen_units, seen_text = [], [], [], 0, set(), set()
        for score, cid, ctx in scored[:80]:
            digest = _text_sha(ctx["text"]); ids = set(ctx["unit_ids"])
            summary = {"id": cid, "source_id": ctx["source_id"], "title": ctx["title"],
                       "kind": ctx["kind"], "score": round(score, 5),
                       "source_text_chars": ctx["source_text_chars"], "unit_ids": ctx["unit_ids"],
                       "matched_query_indexes": sorted(context_queries[cid]),
                       "source_url": ctx["source_url"], "local_source_url": ctx["local_source_url"],
                       "dates": ctx["dates"], "complete_within_boundary": ctx["complete_within_boundary"]}
            if digest in seen_text or (ids and len(ids.intersection(seen_units))/len(ids) >= .6):
                summary["selection"] = "omitted_overlapping_context"
            elif len(selected) >= limit:
                summary["selection"] = "omitted_context_limit"
            elif ctx["source_text_chars"] + used > budget_chars:
                summary["selection"] = "omitted_character_budget"
                omitted.append({"context_id": cid, "reason": "Complete context exceeds remaining text budget; no snippet substituted.", "source_text_chars": ctx["source_text_chars"]})
            else:
                summary["selection"] = "selected"
                # Do not mutate cached reviewed contexts across concurrent calls.
                record = dict(ctx); record["retrieval_score"] = round(score, 5)
                selected.append(record); used += ctx["source_text_chars"]
                seen_units.update(ids); seen_text.add(digest)
            candidates.append(summary)
        return {"query": query, "query_variants": variants, "selected_contexts": selected,
                "candidate_pool": candidates, "scope": {
                    "method": "Read-only SQLite FTS5 + lexical source-text ranking + complete-context expansion; no embeddings or live web retrieval.",
                    "canonical_sources": len(self.sources), "canonical_units": len(self.info),
                    "sources_with_imported_text": sum(bool(s.get('unit_count')) for s in self.sources.values()),
                    "excluded_units": len(self.excluded), "accepted_corrected_units": len(self.patches),
                    "reviewed_contexts_available": len(self.reviewed),
                    "fts_unit_candidates": len(ranking), "expanded_contexts_scored": len(scored),
                    "candidate_pool_limit": 80, "selected_contexts": len(selected),
                    "source_text_chars": used, "budget_chars": budget_chars,
                    "budget_basis": "Source text only; metadata and editorial claim annotations are additional.",
                    "english_lexical_variants_available": any(qtokens),
                    "search_is_exhaustive_topic_review": False,
                    "originals_changed": False, "input_fingerprint": self.input_fingerprint},
                "gaps": {
                    "excluded_material": ["Reference-only pages and uncaptured article bodies in the canonical catalog.",
                                          "Unverified third-party speech transcripts, including the Florida comparison copy.",
                                          "Confirmed duplicates and unresolved extraction defects, except separately hash-verified accepted replacements.",
                                          "New derived article captures outside the canonical/reviewed context index; their completeness is not implied by this search."],
                    "budget_omissions": omitted, "fts_errors": fts_errors,
                    "query_warnings": [] if any(qtokens) else ["No searchable English terms were supplied. The caller must provide English query variants for an English corpus."],
                    "initialization_warnings": self.initialization_warnings,
                    "limitations": ["Keyword variants and ranking can miss relevant or contrary passages; retrieved matches do not establish topic completeness.",
                                    "Unreviewed source extraction is explicitly distinguished from reviewed claim metadata.",
                                    "Meeting chapter boundaries may omit delayed follow-ups in other chapters; page windows are not complete documents.",
                                    "Source statements are historical. No present-market or user-specific applicability has been assessed.",
                                    "Unlabelled speakers stay unknown; candidate attribution is not promoted to a fact."]}}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library_path")
    parser.add_argument("query")
    parser.add_argument("--variant", action="append", default=[])
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--budget-chars", type=int, default=65000)
    args = parser.parse_args()
    print(json.dumps(Retriever(args.library_path).search(args.query, args.variant, args.limit, args.budget_chars), ensure_ascii=False, indent=2))
