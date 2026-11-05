"""Focused source-preservation checks; not a semantic answer-quality evaluation.

Run from the project root with:
    PYTHONDONTWRITEBYTECODE=1 python3 work/qa_live/test_retrieval.py
No sealed evaluation material is read.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import unittest
from urllib.parse import unquote

from retrieval import Retriever, _sha, _text_sha


LIBRARY = Path(__file__).resolve().parents[1] / "data" / "library"


class RetrievalPreservation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = _sha(LIBRARY / "原文知识库.sqlite")
        cls.retriever = Retriever(LIBRARY)

    @classmethod
    def tearDownClass(cls):
        if _sha(LIBRARY / "原文知识库.sqlite") != cls.before:
            raise AssertionError("Canonical database changed")

    def test_read_only_connection_and_loaded_approvals(self):
        r = self.retriever
        self.assertFalse(r.initialization_warnings)
        self.assertEqual(len(r.reviewed), 6)
        self.assertEqual(len(r.patches), 6)
        with r._connection() as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("CREATE TABLE retrieval_test_mutation_should_fail (x)")

    def test_full_reviewed_context_and_source_locator(self):
        r = self.retriever
        context = r.context_for_unit("cnbc-meeting-2021-part-1-ch12")
        self.assertEqual(context["id"], "meeting-2021-index-estate")
        self.assertEqual(len(context["paragraphs"]), 30)
        self.assertEqual(set(context["unit_ids"]), {
            "cnbc-meeting-2021-part-1-ch12", "cnbc-meeting-2021-part-1-ch13"})
        self.assertEqual(context["dates"]["event_date"], "2021-05-01")
        self.assertIsNone(context["dates"]["publication_date"])
        self.assertIn("part-1---2019-", context["source_url"])
        self.assertEqual(_sha(LIBRARY / unquote(context["local_source_url"])),
                         context["source_raw_sha256"])
        self.assertFalse(context["truncated"])

    def test_paragraph_text_offsets_and_attribution_are_preserved(self):
        r = self.retriever
        context = r.context_for_unit("cnbc-meeting-2021-part-1-ch12")
        originals = {p["id"]: p for uid in context["unit_ids"]
                     for p in r._unit(uid)["paragraphs"]}
        unknown = 0
        for p in context["paragraphs"]:
            text = context["text"][p["text_start"]:p["text_end"]]
            self.assertEqual(_text_sha(text), p["returned_text_sha256"])
            source = originals[p["id"]]
            self.assertEqual(text, source["reading_text"])
            self.assertEqual(p["speaker"], source.get("canonical_speaker"))
            self.assertEqual(p["candidate_speaker"], source.get("candidate_speaker"))
            self.assertEqual(p["audio_checked"], source["audio_checked"])
            self.assertEqual(p["locator"], source["locator"])
            self.assertIn(p["source_unit_id"], context["unit_ids"])
            if source.get("canonical_speaker") is None:
                unknown += 1
        self.assertGreater(unknown, 0)

    def test_exact_accepted_replacement_only(self):
        r = self.retriever
        uid = "nbc-brokaw-interview-date-unresolved:p021"
        context = r.context_for_unit(uid)
        self.assertIsNotNone(context)
        p = next(x for x in context["paragraphs"] if x["id"] == uid)
        text = context["text"][p["text_start"]:p["text_end"]]
        self.assertEqual(_text_sha(text), r.patches[uid]["derived_text_sha256"])
        self.assertNotEqual(text, r._unit(uid)["text"])
        self.assertFalse(p["applied_correction"]["answer_eligibility_granted"])
        self.assertIsNone(p["speaker"])
        self.assertIsNone(context["dates"]["event_date"])

    def test_budget_excludes_whole_contexts_without_snippets(self):
        r = self.retriever
        packet = r.search("index funds", limit=20, budget_chars=7000)
        selected = packet["selected_contexts"]
        self.assertLessEqual(sum(len(c["text"]) for c in selected), 7000)
        self.assertTrue(packet["gaps"]["budget_omissions"])
        for c in selected:
            self.assertFalse(c["truncated"])
            if c["id"] in r.reviewed:
                self.assertEqual(c["text"], r.reviewed[c["id"]]["text"])
        zero = r.search("index funds", budget_chars=0)
        self.assertEqual(zero["selected_contexts"], [])
        self.assertTrue(zero["gaps"]["budget_omissions"])

    def test_query_syntax_and_language_failure_are_explicit(self):
        r = self.retriever
        packet = r.search('index \" OR (fund*) NEAR: -{ weird]')
        self.assertFalse(packet["gaps"]["fts_errors"])
        chinese = r.search("现在应该买指数基金吗")
        self.assertEqual(chinese["selected_contexts"], [])
        self.assertTrue(chinese["gaps"]["query_warnings"])
        expanded = r.search("现在应该买指数基金吗", ["index fund valuations"])
        self.assertTrue(expanded["selected_contexts"])
        self.assertFalse(expanded["gaps"]["query_warnings"])

    def test_exclusions_and_editorial_separation(self):
        r = self.retriever
        for uid in r.excluded:
            self.assertIsNone(r.context_for_unit(uid))
        for context in r.reviewed.values():
            self.assertEqual(context["editorial_annotations"]["kind"],
                             "reviewed_claim_metadata_not_source_quotation")
            self.assertTrue(context["complete_within_boundary"])
        packet = r.search("insurance float", ["underwriting cost float"])
        for context in packet["selected_contexts"]:
            self.assertTrue(r._raw_valid(context["source_id"]))
            self.assertNotIn(context["source_kind"], {"interview_candidate", "speech_candidate"})
            self.assertNotIn("florida", context["source_id"].lower())
        self.assertFalse(packet["scope"]["search_is_exhaustive_topic_review"])

    def test_concurrent_reads_do_not_change_cached_packets(self):
        from concurrent.futures import ThreadPoolExecutor
        r = self.retriever
        before = json.dumps(r.reviewed, sort_keys=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            packets = list(pool.map(r.search, ["insurance float", "circle competence"]))
        self.assertTrue(all(p["selected_contexts"] for p in packets))
        self.assertEqual(before, json.dumps(r.reviewed, sort_keys=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
