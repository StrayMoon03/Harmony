import importlib.util
import unittest
import io
import json
from contextlib import redirect_stderr
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("reel", Path(__file__).with_name("instagramReelBrowser.py"))
reel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reel)


class ExactReelTests(unittest.TestCase):
    def test_actual_main_navigation_failure_and_listener_parse_signals(self):
        sync = MagicMock()
        browser = sync.return_value.__enter__.return_value.chromium.launch.return_value
        page = browser.new_context.return_value.new_page.return_value
        page.goto.side_effect = RuntimeError("PRIVATE SIGNED URL")
        signals = {}
        with patch.dict("sys.modules", {"playwright.sync_api": SimpleNamespace(sync_playwright=sync)}), patch.dict(reel.os.environ, {"INSTAGRAM_COOKIES": ""}), patch.object(reel.sys, "argv", ["helper", "https://www.instagram.com/reel/EXACT/"]):
            with self.assertRaises(RuntimeError):
                reel.main(signals)
        self.assertTrue(signals["playwrightImported"])
        self.assertTrue(signals["browserLaunched"])
        self.assertTrue(signals["pageCreated"])
        self.assertFalse(signals.get("navigationCompleted", False))
        browser.close.assert_called_once()
        self.assertEqual(page.on.call_args.args[0], "response")
        listener = page.on.call_args.args[1]
        response = MagicMock(url="https://i.instagram.com/api/v1/media/123/info/")
        response.json.side_effect = ValueError("PRIVATE PAYLOAD")
        listener(response)
        self.assertTrue(signals["inspectResponseSeen"])
        self.assertTrue(signals["responseJsonFailed"])
        response.json.side_effect = None
        response.json.return_value = self.video("OTHER")
        listener(response)
        self.assertTrue(signals["responseJsonParsed"])
        self.assertFalse(signals.get("exactRecordSeen", False))
        response.json.return_value = self.video()
        listener(response)
        self.assertTrue(signals["exactRecordSeen"])
        self.assertTrue(signals["allowedVideoCandidateSeen"])

    def test_diagnostics_only_keep_allowlisted_booleans(self):
        output = io.StringIO()
        with redirect_stderr(output):
            reel.emit_diagnostics({"exactRecordSeen": True, "cookiesLoaded": "SECRET", "url": "SIGNED", "cookie": "SECRET"})
        report = json.loads(output.getvalue().split(":", 1)[1])
        self.assertEqual(set(report), set(reel.DIAGNOSTIC_KEYS))
        self.assertTrue(report["exactRecordSeen"])
        self.assertFalse(report["cookiesLoaded"])
        self.assertTrue(all(type(value) is bool for value in report.values()))
        self.assertNotIn("SECRET", output.getvalue())
        self.assertNotIn("SIGNED", output.getvalue())

    def test_failed_start_emits_stage_not_exception(self):
        def fail(signals):
            raise RuntimeError("PRIVATE COOKIE SIGNED URL")
        output = io.StringIO()
        with redirect_stderr(output):
            self.assertEqual(reel.run(fail), 1)
        self.assertNotIn("PRIVATE", output.getvalue())
        report = json.loads(output.getvalue().split("HARMONY_INSTAGRAM_DIAGNOSTICS:")[1])
        self.assertTrue(report["helperStarted"])
        self.assertFalse(report["playwrightImported"])

    def test_failed_navigation_preserves_previous_stages(self):
        def fail(signals):
            signals.update(playwrightImported=True, browserLaunched=True, pageCreated=True)
            raise RuntimeError("SIGNED")
        output = io.StringIO()
        with redirect_stderr(output):
            self.assertEqual(reel.run(fail), 1)
        report = json.loads(output.getvalue().split("HARMONY_INSTAGRAM_DIAGNOSTICS:")[1])
        self.assertTrue(report["pageCreated"])
        self.assertFalse(report["navigationCompleted"])

    def test_record_diagnostics_do_not_promote_foreign_video(self):
        signals = {}
        reel.record_signals({"code": "EXACT", "quote": self.video("OTHER")}, "EXACT", signals)
        self.assertEqual(signals, {"exactRecordSeen": True})
        reel.record_signals({"code": "EXACT", "post": self.video()}, "EXACT", signals)
        self.assertTrue(signals["exactVideoDeclared"])

    def video(self, code="EXACT", **extra):
        return {"code": code, "media_type": 2, "video_versions": [{"url": "https://scontent-a.cdninstagram.com/owned.mp4"}], **extra}

    def test_exact_video(self):
        self.assertEqual(reel.extract_reel(self.video(), "EXACT")["code"], "EXACT")

    def test_neighbor_ignored(self):
        with self.assertRaises(ValueError):
            reel.extract_reel({"code": "EXACT", "neighbor": self.video("OTHER")}, "EXACT")

    def test_nested_exact_record(self):
        self.assertIn("owned.mp4", reel.extract_reel({"code": "EXACT", "post": self.video()}, "EXACT")["videos"][0])

    def test_foreign_quote_ignored(self):
        with self.assertRaises(ValueError):
            reel.extract_reel({"code": "EXACT", "quoted_post": self.video("QUOTE")}, "EXACT")

    def test_photo_poster_not_video(self):
        with self.assertRaises(ValueError):
            reel.extract_reel({"code": "EXACT", "media_type": 1, "image_versions2": {"candidates": []}}, "EXACT")

    def test_graphql_video_fields(self):
        self.assertEqual(reel.extract_reel({"shortcode": "EXACT", "is_video": True, "video_url": "https://scontent-a.fbcdn.net/owned.mp4"}, "EXACT")["code"], "EXACT")

    def test_best_owned_version(self):
        record = self.video(video_versions=[{"url": "https://scontent-a.fbcdn.net/small.mp4", "width": 1, "height": 1}, {"url": "https://scontent-a.fbcdn.net/large.mp4", "width": 20, "height": 20}])
        self.assertEqual(reel.extract_reel(record, "EXACT")["videos"], ["https://scontent-a.fbcdn.net/large.mp4", "https://scontent-a.fbcdn.net/small.mp4"])

    def test_progressive_first_and_duplicate_removed(self):
        record = self.video(video_url="https://scontent-a.fbcdn.net/muxed.mp4", video_versions=[
            {"url": "https://scontent-a.fbcdn.net/large.mp4", "width": 20, "height": 20},
            {"url": "https://scontent-a.fbcdn.net/muxed.mp4", "width": 1, "height": 1}])
        self.assertEqual(reel.extract_reel(record, "EXACT")["videos"], ["https://scontent-a.fbcdn.net/muxed.mp4", "https://scontent-a.fbcdn.net/large.mp4"])

    def test_empty_sidecar_is_not_carousel(self):
        self.assertTrue(reel.extract_reel(self.video(edge_sidecar_to_children={"edges": []}, video_url="https://scontent-a.fbcdn.net/muxed.mp4"), "EXACT")["videos"])

    def test_nonempty_sidecar_is_rejected(self):
        with self.assertRaises(ValueError):
            reel.extract_reel(self.video(edge_sidecar_to_children={"edges": [{"node": self.video("OTHER")}] }), "EXACT")

    def test_listener_host_and_path_allowlist(self):
        self.assertTrue(reel.allowed_response("https://i.instagram.com/api/v1/media/123/info/"))
        self.assertTrue(reel.allowed_response("https://www.instagram.com/graphql/query"))
        for url in ["https://evil.instagram.com.attacker.test/api/v1/media/", "https://i.instagram.com/reel/EXACT/", "http://i.instagram.com/api/v1/", "https://user:pass@i.instagram.com/api/v1/"]:
            self.assertFalse(reel.allowed_response(url))

    def test_untrusted_cdn_rejected(self):
        for url in ["https://fbcdn.net.evil.test/file.mp4", "http://scontent-a.fbcdn.net/file.mp4", "https://user:secret@scontent-a.fbcdn.net/file.mp4", "https://scontent-a.fbcdn.net:8080/file.mp4"]:
            self.assertFalse(reel.allowed_video(url))

    def test_carousel_not_misrepresented_as_reel(self):
        with self.assertRaises(ValueError):
            reel.extract_reel(self.video(carousel_media=[self.video("OTHER")]), "EXACT")

    def test_stub_rejected(self):
        with self.assertRaises(ValueError):
            reel.extract_reel({"code": "EXACT"}, "EXACT")

    def test_case_sensitive_shortcode(self):
        with self.assertRaises(ValueError):
            reel.extract_reel(self.video("exact"), "EXACT")

    def test_url_validation(self):
        self.assertEqual(reel.reel_code("https://www.instagram.com/reel/EXACT/"), "EXACT")
        for url in ["https://evil.test/reel/EXACT/", "http://www.instagram.com/reel/EXACT/", "https://www.instagram.com/accounts/login/"]:
            with self.assertRaises(ValueError):
                reel.reel_code(url)


if __name__ == "__main__":
    unittest.main()
