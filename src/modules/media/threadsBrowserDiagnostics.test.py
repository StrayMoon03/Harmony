import importlib.util
import io
import json
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path

playwright = types.ModuleType("playwright")
api = types.ModuleType("playwright.sync_api")
api.sync_playwright = lambda: None
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = api
spec = importlib.util.spec_from_file_location("threads_browser", Path(__file__).with_name("threadsBrowser.py"))
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class Page:
    def __init__(self, result=None, error=False):
        self.result = result
        self.error = error

    def evaluate(self, script):
        if self.error:
            raise RuntimeError("private page detail")
        return self.result


class DiagnosticsTests(unittest.TestCase):
    def collect(self, page, records):
        stream = io.StringIO()
        with redirect_stdout(stream):
            browser.emit_page_diagnostics(page, records)
        line = stream.getvalue()
        self.assertNotIn("private", line)
        self.assertNotIn("https:", line)
        return json.loads(line.split(":", 1)[1])

    def test_only_boolean_allowlist_leaves_browser(self):
        safe = self.collect(Page({"loginPromptVisible": True, "accountMenuVisible": "true",
                                 "pageSignalsAvailable": True, "cookies": "private", "url": "https://private"}),
                            {"exactRecordSeen": True, "title": "private", "loginRoute": True})
        self.assertEqual(set(safe), set(browser.DIAGNOSTIC_KEYS))
        self.assertTrue(safe["loginPromptVisible"])
        self.assertTrue(safe["exactRecordSeen"])
        self.assertFalse(safe["accountMenuVisible"])
        self.assertFalse(safe["loginRoute"])
        self.assertTrue(all(type(value) is bool for value in safe.values()))

    def test_unreadable_page_does_not_raise_or_claim_login(self):
        safe = self.collect(Page(error=True), {})
        self.assertFalse(any(safe.values()))

    def test_exact_root_video_only_not_neighbor(self):
        signals = {}
        browser.record_diagnostic_signals({"other": {"code": "OTHER", "media_type": 2},
                                          "root": {"code": "EXACT", "media_type": 1}}, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True})
        browser.record_diagnostic_signals({"code": "EXACT", "media_type": 2}, "EXACT", signals)
        self.assertTrue(signals["rootVideoDeclared"])

    def test_inline_video_is_distinct_from_root(self):
        signals = {}
        browser.record_diagnostic_signals({"code": "EXACT", "text_post_app_info": {
            "linked_inline_media": {"video_versions": [{"url": "https://private"}]}}}, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True, "attachedVideoDeclared": True})

    def test_no_exact_record_stays_unknown(self):
        signals = {}
        browser.record_diagnostic_signals({"code": "OTHER", "media_type": 2}, "EXACT", signals)
        self.assertEqual(signals, {})


if __name__ == "__main__":
    unittest.main()
