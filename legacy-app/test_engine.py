"""Deterministic backend regressions; no model calls or benchmark files.

Run from the project root:
    PYTHONDONTWRITEBYTECODE=1 python3 work/qa_live/test_engine.py

All source fixtures are synthetic and temporary. HTTP handlers run in memory;
no port is opened, archived HTML executed, or source corpus changed.
"""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

import engine
import evaluate
import provider
import server


SENTINEL = "GRADING_ONLY_SENTINEL"


def fixture_reference(library):
    raw = library / "raw" / "synthetic.txt"
    raw.parent.mkdir(parents=True, exist_ok=True)
    paragraphs = [
        {"id": "p1", "reading_text": "A known-label source sentence.",
         "canonical_speaker": "Warren Buffett", "speaker": "Wrong legacy fallback",
         "candidate_speaker": "Warren Buffett", "explicit_speaker_label": "WARREN BUFFETT",
         "speaker_label": "Wrong legacy label", "attribution_basis": "explicit_text_label",
         "author_attribution": "Synthetic source author", "expected_claim": SENTINEL},
        {"id": "p2", "reading_text": "An unlabeled continuation remains uncertain.",
         "canonical_speaker": None, "speaker": "Wrong legacy fallback",
         "candidate_speaker": "Warren Buffett", "explicit_speaker_label": None,
         "attribution_basis": "candidate_only_no_explicit_label"},
        {"id": "p3", "reading_text": "A legacy-labelled synthetic source sentence.",
         "speaker": "Charlie Munger", "speaker_label": "CHARLIE MUNGER",
         "speaker_basis": "legacy_explicit_label"},
    ]
    text = "\n\n".join(p["reading_text"] for p in paragraphs)
    raw.write_text(text, encoding="utf-8")
    return {"context_id": "synthetic-context", "source_id": "synthetic-source",
            "title": "Synthetic fixture, not a historical source",
            "source_url": "https://example.invalid/synthetic",
            "raw_path": str(raw), "raw_sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
            "context_text": text, "paragraphs": paragraphs,
            "boundary": "Three complete synthetic paragraphs.",
            "grading_rubric": SENTINEL, "gold_answer": SENTINEL}


def answer_with_action(status="partial"):
    return {"title": "Synthetic answer", "short_answer": [
        {"id": "summary", "text": "This synthetic source has limited scope.", "citations": []}],
        "sections": [], "practical_implications": [
            {"id": "action", "text": "Buy a fund today.", "citations": []}],
        "limitations": [], "follow_up_questions": [], "evidence_status": status}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="buffett-engine-test-")
        self.addCleanup(self.temp.cleanup)
        self.library = Path(self.temp.name).resolve() / "library"
        self.reference = fixture_reference(self.library)
        self.context = evaluate.reference_context(self.reference, self.library)

    def test_null_canonical_is_preserved_and_candidate_not_promoted(self):
        paragraphs = self.context["paragraphs"]
        self.assertEqual(paragraphs[0]["speaker"], "Warren Buffett")
        self.assertEqual(paragraphs[0]["speaker_label"], "WARREN BUFFETT")
        self.assertIsNone(paragraphs[1]["speaker"])
        self.assertEqual(paragraphs[1]["candidate_speaker"], "Warren Buffett")
        self.assertEqual(paragraphs[2]["speaker"], "Charlie Munger")
        self.assertEqual(paragraphs[2]["attribution_basis"], "legacy_explicit_label")
        compact = engine.model_context(self.context)
        self.assertEqual(compact["text"], self.reference["context_text"])
        compact_paragraphs = compact["paragraph_attribution"]
        self.assertIn("speaker", compact_paragraphs[1])
        self.assertIsNone(compact_paragraphs[1]["speaker"])
        self.assertEqual(compact_paragraphs[1]["candidate_speaker"], "Warren Buffett")
        self.assertEqual(compact_paragraphs[0]["author_attribution"], "Synthetic source author")
        for source, converted in zip(self.reference["paragraphs"], compact_paragraphs):
            self.assertEqual(compact["text"][converted["text_start"]:converted["text_end"]],
                             source["reading_text"])

    def test_reference_rubrics_never_enter_model_or_engine_arguments(self):
        self.assertNotIn(SENTINEL, json.dumps(self.context))
        self.assertNotIn(SENTINEL, json.dumps(engine.model_context(self.context)))
        seen = {}
        class FakeEngine:
            def answer(self, *args, **kwargs):
                seen.update(args=args, kwargs=kwargs)
                return {"synthetic": True}
        question = {"id": "synthetic", "question": "Synthetic question",
                    "reference_context_ids": [self.context["id"]],
                    "grading_rubric": SENTINEL, "gold_answer": SENTINEL}
        result = evaluate.run_case(FakeEngine(), question, {self.context["id"]: self.context},
                                   "reference", Path(self.temp.name))
        self.assertEqual(result["status"], "completed")
        self.assertNotIn(SENTINEL, json.dumps(seen, default=str))

    def test_reference_hash_mismatch_is_rejected(self):
        self.reference["raw_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash changed"):
            evaluate.reference_context(self.reference, self.library)

    def test_source_view_retains_reproducibility_metadata(self):
        self.context.update(complete_within_boundary=False,
                            omitted_units=[{"unit_id": "missing", "reason": "synthetic gap"}],
                            source_quality={"issues": ["synthetic source issue"]})
        view = engine.source_view(self.context)
        self.assertEqual(view["source_raw_sha256"], self.reference["raw_sha256"])
        self.assertEqual(view["context_text_sha256"],
                         hashlib.sha256(self.context["text"].encode()).hexdigest())
        self.assertFalse(view["complete_within_boundary"])
        self.assertEqual(view["omitted_units"], self.context["omitted_units"])
        self.assertEqual(view["source_quality"], self.context["source_quality"])

    def test_partial_practical_action_requires_a_citation(self):
        issues = engine.validate_citations(answer_with_action(), [self.context])
        self.assertTrue(any(x["block_id"] == "action" and x["severity"] == "material" for x in issues))

    def test_nonexistent_quote_rejected_even_with_valid_source_id(self):
        answer = answer_with_action()
        answer["practical_implications"][0]["citations"] = [
            {"source_id": self.context["id"], "quote": "A fabricated quotation from nowhere."}]
        self.assertTrue(any(x["severity"] == "critical" for x in
                            engine.validate_citations(answer, [self.context])))

    def test_mechanical_failure_withholds_even_if_model_reviewer_passes(self):
        plan = {"standalone_question": "Synthetic question", "queries": ["synthetic"],
                "required_aspects": [], "needs_current_facts": False, "domain": "buffett"}
        draft = answer_with_action()
        approval = {"pass": True, "issues": [], "notes": []}
        replies = iter([plan, draft, approval, draft, approval])
        subject = engine.Engine.__new__(engine.Engine)
        subject.provider = types.SimpleNamespace(complete=lambda *args: (next(replies), {"mocked": True}))
        result = subject.answer("Synthetic question", reference_contexts=[self.context])
        self.assertEqual(result["review"]["status"], "withheld")
        self.assertEqual(result["answer"]["practical_implications"], [])
        self.assertEqual(len(result["review"]["checks"]), 2)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="buffett-provider-test-")
        self.addCleanup(self.temp.cleanup)
        self.provider = provider.CodexProvider.__new__(provider.CodexProvider)
        self.provider.runtime = Path(self.temp.name).resolve()
        self.provider.binary = "synthetic-codex-not-executed"
        self.provider.model = "synthetic-model"
        self.provider._process_lock = threading.Lock()
        self.provider._active_processes = {}
        self.provider._closed = False

    @staticmethod
    def output():
        return json.dumps({"type": "item.completed", "item": {
            "type": "agent_message", "text": '{"ok":true}'}}) + "\n" + json.dumps({
                "type": "turn.completed", "usage": {"input_tokens": 1}})

    def test_scoped_invocation(self):
        process = types.SimpleNamespace(returncode=0, communicate=lambda *a, **kw: (self.output(), ""))
        with patch.object(provider.subprocess, "Popen", return_value=process) as spawn:
            value, _ = self.provider.complete("synthetic", {"type": "object"})
        command = spawn.call_args.args[0]
        for token in ("--ignore-user-config", "--ephemeral", "read-only", "sleep_tool", "tool_suggest"):
            self.assertIn(token, command)
        self.assertEqual(value, {"ok": True})
        self.assertTrue(Path(spawn.call_args.kwargs["cwd"]).is_relative_to(self.provider.runtime))

    def test_unexpected_tool_event_is_rejected(self):
        stdout = json.dumps({"type": "item.completed", "item": {"type": "command_execution"}}) + "\n" + self.output()
        process = types.SimpleNamespace(returncode=0, communicate=lambda *a, **kw: (stdout, ""))
        with patch.object(provider.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(provider.ProviderError, "tool activity"):
                self.provider.complete("synthetic", {"type": "object"})

    def test_timeout_escalation_has_bounded_waits(self):
        timeouts = []
        def communicate(*args, **kwargs):
            timeouts.append(kwargs.get("timeout"))
            if len(timeouts) < 3:
                raise subprocess.TimeoutExpired("synthetic", kwargs.get("timeout"))
            return "", ""
        process = types.SimpleNamespace(pid=123456, returncode=0, communicate=communicate)
        with patch.object(provider.subprocess, "Popen", return_value=process), patch.object(provider.os, "killpg") as kill:
            with self.assertRaisesRegex(provider.ProviderError, "too long"):
                self.provider.complete("synthetic", {"type": "object"}, timeout=9)
        self.assertEqual(timeouts, [9, 5, 5])
        self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(self.provider._active_processes, {})

    def test_close_stops_active_child_and_rejects_later_stages(self):
        started, terminated = threading.Event(), threading.Event()
        errors = []
        class BlockingProcess:
            pid = 123456
            returncode = None
            def communicate(self, *args, **kwargs):
                started.set()
                if not terminated.wait(2):
                    raise AssertionError("Mocked child was not terminated")
                return "", ""
            def poll(self): return self.returncode
            def wait(self, timeout):
                if not terminated.wait(timeout):
                    raise subprocess.TimeoutExpired("synthetic", timeout)
                return self.returncode
        process = BlockingProcess()
        def signal_child(pid, sig):
            self.assertEqual(pid, process.pid)
            process.returncode = -sig
            terminated.set()
        def run():
            try: self.provider.complete("synthetic", {"type": "object"})
            except Exception as exc: errors.append(exc)
        with patch.object(provider.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(provider.os, "killpg", side_effect=signal_child) as kill:
            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(started.wait(2))
            self.provider.close()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], provider.ProviderError)
            self.assertIn("stopped", str(errors[0]))
            self.assertEqual(self.provider._active_processes, {})
            self.provider.close()
            with self.assertRaisesRegex(provider.ProviderError, "stopped"):
                self.provider.complete("later stage", {"type": "object"})
            self.assertEqual(spawn.call_count, 1)
            self.assertEqual(kill.call_count, 1)

    def test_close_escalates_an_unresponsive_child_with_bounded_waits(self):
        waits = []
        def wait(timeout):
            waits.append(timeout)
            raise subprocess.TimeoutExpired("synthetic", timeout)
        process = types.SimpleNamespace(pid=123456, poll=lambda: None, wait=wait)
        self.provider._active_processes[id(process)] = process
        with patch.object(provider.os, "killpg") as kill:
            self.provider.close()
        self.assertEqual(waits, [5, 5])
        self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        self.assertTrue(self.provider._closed)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="buffett-server-test-")
        self.addCleanup(self.temp.cleanup)
        self.library = Path(self.temp.name).resolve() / "library"
        for rel in ("reader/index.html", "meetings/raw/source.html"):
            target = self.library / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('<html><style>body{color:black}</style><script>window.synthetic=true;</script></html>')
        capture = {}
        class FakeEngine:
            def __init__(self, *args):
                self.provider = types.SimpleNamespace(name="mock", status=lambda: (True, "mock"),
                                                      close=lambda: capture.update(provider_closed=True))
        class FakeServer:
            def __init__(self, address, handler):
                capture.update(address=address, handler=handler)
            def serve_forever(self): pass
            def server_close(self): pass
        self.port = 18957
        with patch.object(server, "Engine", FakeEngine), patch.object(server, "ThreadingHTTPServer", FakeServer), \
                patch.object(sys, "argv", ["server.py", "--library", str(self.library), "--port", str(self.port)]), \
                contextlib.redirect_stdout(io.StringIO()):
            server.main()
        self.assertEqual(capture["address"], ("127.0.0.1", self.port))
        self.assertTrue(capture["provider_closed"])
        self.handler = capture["handler"]

    def request(self, path, method="GET", headers=None, body=b""):
        h = self.handler.__new__(self.handler)
        h.path = path
        h.headers = {"Host": "127.0.0.1:" + str(self.port), **(headers or {})}
        h.rfile, h.wfile = io.BytesIO(body), io.BytesIO()
        result = {"headers": {}}
        h.send_response = lambda value: result.update(status=value)
        h.send_header = lambda key, value: result["headers"].update({key: value})
        h.end_headers = lambda: None
        getattr(h, "do_" + method)()
        result["body"] = h.wfile.getvalue()
        return result

    def test_raw_html_alias_cannot_gain_generated_page_script_permissions(self):
        direct = self.request("/library/meetings/raw/source.html")
        alias = self.request("/library/reader/../meetings/raw/source.html")
        self.assertEqual(direct["status"], 200)
        self.assertEqual(alias["status"], 200)
        self.assertEqual(direct["headers"]["Content-Security-Policy"], alias["headers"]["Content-Security-Policy"])
        self.assertTrue(alias["headers"]["Content-Security-Policy"].startswith("sandbox; default-src 'none'"))
        generated = self.request("/library/reader/index.html")
        self.assertIn("'sha256-", generated["headers"]["Content-Security-Policy"])
        self.assertNotIn("unsafe-inline", generated["headers"]["Content-Security-Policy"])

    def test_raw_html_charset_preserves_bytes_and_sandbox(self):
        fixtures = [
            ("legacy.html", "<p>Buffett’s company</p>".encode("cp1252"), "windows-1252"),
            ("utf8.html", "<p>Buffett’s company</p>".encode("utf-8"), "utf-8"),
            ("declared.html", '<meta charset="iso-8859-2"><p>Łódź</p>'.encode("iso-8859-2"), "iso-8859-2"),
            ("http-equiv.html", '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>“Source”</p>'.encode("cp1252"), "windows-1252"),
            ("wrong-declaration.html", '<meta charset="utf-8"><p>“Source”</p>'.encode("cp1252"), "windows-1252"),
        ]
        for name, body, charset in fixtures:
            with self.subTest(name=name):
                path = self.library / "meetings" / "raw" / name
                path.write_bytes(body)
                response = self.request("/library/meetings/raw/" + name)
                self.assertEqual(response["status"], 200)
                self.assertEqual(response["headers"]["Content-Type"], "text/html; charset=" + charset)
                self.assertEqual(response["body"], body)
                self.assertEqual(path.read_bytes(), body)
                self.assertTrue(response["headers"]["Content-Security-Policy"].startswith("sandbox; default-src 'none'"))
                alias = self.request("/library/reader/../meetings/raw/" + name)
                self.assertEqual(alias["headers"], response["headers"])
                self.assertEqual(alias["body"], body)
        generated = self.request("/library/reader/index.html")
        self.assertEqual(generated["headers"]["Content-Type"], "text/html; charset=utf-8")

    def test_loopback_validation_and_library_escape(self):
        self.assertEqual(self.request("/api/status", headers={"Host": "other.example"})["status"], 403)
        self.assertEqual(self.request("/library/%2e%2e/outside.txt")["status"], 404)
        origin = "http://127.0.0.1:" + str(self.port)
        self.assertEqual(self.request("/api/questions", "POST", {"Origin": "https://other.example"})["status"], 403)
        self.assertEqual(self.request("/api/questions", "POST", {"Origin": origin})["status"], 403)
        status = json.loads(self.request("/api/status")["body"])
        self.assertEqual(status["app"], "buffett_questions")
        token = status["csrf_token"]
        body = b'{"question":"valid question", "history":{}}'
        self.assertEqual(self.request("/api/questions", "POST", {
            "Origin": origin, "X-QA-Token": token, "Content-Length": str(len(body))}, body)["status"], 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
