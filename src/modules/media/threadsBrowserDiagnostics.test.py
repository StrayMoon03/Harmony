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
                            {"exactRecordSeen": True, "title": "private", "loginRoute": True,
                             "exactRecordHasImageVersions": True, "exactNestedSameCodeRecordSeen": True})
        self.assertEqual(set(safe), set(browser.DIAGNOSTIC_KEYS))
        self.assertTrue(safe["loginPromptVisible"])
        self.assertTrue(safe["exactRecordSeen"])
        self.assertTrue(safe["exactRecordHasImageVersions"])
        self.assertTrue(safe["exactNestedSameCodeRecordSeen"])
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

    def test_sibling_same_code_is_not_reported_as_nested(self):
        payload = [{"code": "EXACT"}, {"shortcode": "EXACT", "media_type": 2,
                   "video_versions": [{"url": "https://scontent-a.fbcdn.net/owned.mp4"}]}]
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertTrue(signals["rootVideoDeclared"])
        self.assertFalse(signals.get("exactNestedSameCodeRecordSeen"))

    def test_inline_video_is_distinct_from_root(self):
        signals = {}
        browser.record_diagnostic_signals({"code": "EXACT", "text_post_app_info": {
            "linked_inline_media": {"video_versions": [{"url": "https://private"}]}}}, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True, "attachedVideoDeclared": True})

    def test_no_exact_record_stays_unknown(self):
        signals = {}
        browser.record_diagnostic_signals({"code": "OTHER", "media_type": 2}, "EXACT", signals)
        self.assertEqual(signals, {})

    def test_nested_same_code_record_is_not_hidden_by_stub_wrapper(self):
        payload = {"wrapper": {
            "code": "EXACT", "media_type": 1,
            "post": {"code": "EXACT", "media_type": 2,
                     "video_versions": [{"url": "https://scontent-a.fbcdn.net/owned.mp4"}]},
        }}
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"),
                         ["https://scontent-a.fbcdn.net/owned.mp4"])
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertTrue(signals["exactRecordSeen"])
        self.assertTrue(signals["rootVideoDeclared"])
        self.assertTrue(signals["exactNestedSameCodeRecordSeen"])

    def test_nested_foreign_record_does_not_inherit_wrapper_identity(self):
        payload = {"code": "EXACT", "children": [{
            "code": "OTHER", "media_type": 2,
            "video_versions": [{"url": "https://scontent-a.fbcdn.net/other.mp4"}],
            "image_versions2": {"candidates": [{"url": "https://scontent-a.fbcdn.net/other.jpg"}]},
        }]}
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"), [])
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True})

    def test_nested_same_code_matches_existing_shortcode_and_permalink_rules(self):
        for nested_identity in ({"shortcode": "EXACT"},
                                {"permalink": "https://www.threads.com/@example/post/EXACT"}):
            payload = {"code": "EXACT", "children": [{
                **nested_identity, "media_type": 2,
                "video_versions": [{"url": "https://scontent-a.fbcdn.net/owned.mp4"}],
            }]}
            self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"),
                             ["https://scontent-a.fbcdn.net/owned.mp4"])
            signals = {}
            browser.record_diagnostic_signals(payload, "EXACT", signals)
            self.assertTrue(signals["exactNestedSameCodeRecordSeen"])

    def test_nested_unidentified_media_is_not_owned_by_matching_wrapper(self):
        payload = {"code": "EXACT", "post": {
            "media_type": 2,
            "video_versions": [{"url": "https://scontent-a.fbcdn.net/unidentified.mp4"}],
        }}
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"), [])
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True})

    def test_nested_exact_record_still_requires_allowed_media_host(self):
        payload = {"code": "EXACT", "post": {
            "code": "EXACT", "media_type": 2,
            "video_versions": [{"url": "https://untrusted.invalid/video.mp4"}],
        }}
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"), [])

    def test_exact_image_versions_are_distinct_from_video_and_neighbor(self):
        image = {"image_versions2": {"candidates": [{"url": "https://scontent-a.fbcdn.net/owned.jpg"}]}}
        for record in ({"code": "EXACT", **image},
                       {"code": "EXACT", "carousel_media": [image]}):
            signals = {}
            browser.record_diagnostic_signals(record, "EXACT", signals)
            self.assertTrue(signals["exactRecordHasImageVersions"])
            self.assertFalse(signals.get("rootVideoDeclared"))
            self.assertFalse(signals.get("exactNestedSameCodeRecordSeen"))

    def test_new_record_signals_cannot_emit_private_values(self):
        safe = self.collect(Page({"exactRecordHasImageVersions": "https://private"}),
                            {"exactRecordHasImageVersions": "private",
                             "exactNestedSameCodeRecordSeen": {"cookies": "private"}})
        self.assertFalse(safe["exactRecordHasImageVersions"])
        self.assertFalse(safe["exactNestedSameCodeRecordSeen"])

    def test_neighbor_video_is_still_ignored(self):
        payload = {
            "exact": {"code": "EXACT", "media_type": 1},
            "other": {"code": "OTHER", "media_type": 2,
                      "video_versions": [{"url": "https://scontent-a.fbcdn.net/other.mp4"}]},
        }
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"), [])
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True})

    def test_quoted_foreign_code_is_not_treated_as_root_video(self):
        payload = {"code": "EXACT", "text_post_app_info": {"share_info": {
            "quoted_post": {"code": "QUOTE", "media_type": 2,
                            "video_versions": [{"url": "https://scontent-a.fbcdn.net/quote.mp4"}]},
        }}}
        # Preserve the existing explicitly attached quote behavior.
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"),
                         ["https://scontent-a.fbcdn.net/quote.mp4"])
        signals = {}
        browser.record_diagnostic_signals(payload, "EXACT", signals)
        self.assertTrue(signals["attachedVideoDeclared"])
        self.assertFalse(signals.get("rootVideoDeclared"))

    def test_root_media_still_takes_precedence_over_explicit_quote(self):
        payload = {"code": "EXACT", "media_type": 2,
                   "video_versions": [{"url": "https://scontent-a.fbcdn.net/owned.mp4"}],
                   "text_post_app_info": {"share_info": {"quoted_post": {
                       "code": "QUOTE", "media_type": 2,
                       "video_versions": [{"url": "https://scontent-a.fbcdn.net/quote.mp4"}],
                   }}}}
        self.assertEqual(browser.exact_post_media_from_json(payload, "EXACT"),
                         ["https://scontent-a.fbcdn.net/owned.mp4"])

    def test_share_landing_json_is_replayed_once_the_permalink_shortcode_is_known(self):
        payload = {
            "requested": {"code": "DfyI6K1k_hX", "media_type": 1,
                          "image_versions2": {"candidates": [
                              {"url": "https://scontent-a.fbcdn.net/owned.jpg", "width": 1200, "height": 1200},
                          ]}},
            "neighbor": {"code": "OTHER", "media_type": 2,
                         "video_versions": [{"url": "https://scontent-a.fbcdn.net/other.mp4"}]},
        }
        structured = []
        pending = []
        signals = {}
        self.assertIsNone(browser.canonical_post_url("https://www.threads.com/share/BAY2v2hRVZ"))
        browser.ingest_json_payload(payload, None, structured, signals, pending)
        self.assertEqual(structured, [])
        self.assertEqual(signals, {})
        self.assertEqual(len(pending), 1)
        browser.adopt_expected_code("DfyI6K1k_hX", pending, structured, signals)
        self.assertEqual(structured, ["https://scontent-a.fbcdn.net/owned.jpg"])
        self.assertEqual(pending, [])
        self.assertTrue(signals["exactRecordSeen"])
        self.assertTrue(signals["exactRecordHasImageVersions"])
        self.assertFalse(signals.get("rootVideoDeclared"))

    def test_adopting_a_share_shortcode_does_not_take_neighbor_or_nested_quote_media_when_root_has_media(self):
        payload = {"code": "DfxN_m-DwfT", "media_type": 2,
                   "video_versions": [{"url": "https://scontent-a.fbcdn.net/owned.mp4"}],
                   "text_post_app_info": {"share_info": {"quoted_post": {
                       "code": "QUOTE", "media_type": 2,
                       "video_versions": [{"url": "https://scontent-a.fbcdn.net/quote.mp4"}],
                   }}}}
        structured = []
        pending = []
        browser.ingest_json_payload(payload, None, structured, None, pending)
        browser.adopt_expected_code("DfxN_m-DwfT", pending, structured)
        self.assertEqual(structured, ["https://scontent-a.fbcdn.net/owned.mp4"])

    def test_a_plain_rate_limit_payload_without_a_shortcode_does_not_invent_media(self):
        structured = []
        pending = []
        browser.ingest_json_payload({"status": "429"}, None, structured, None, pending)
        browser.adopt_expected_code("EXACT", pending, structured)
        self.assertEqual(structured, [])
        self.assertEqual(pending, [])


if __name__ == "__main__":
    unittest.main()
