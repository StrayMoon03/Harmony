import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("reel", Path(__file__).with_name("instagramReelBrowser.py"))
reel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reel)


class ExactReelTests(unittest.TestCase):
    def video(self, code="EXACT", **extra):
        return {"code": code, "media_type": 2, "video_versions": [{"url": "https://scontent-a.cdninstagram.com/owned.mp4"}], **extra}

    def test_exact_video(self):
        self.assertEqual(reel.extract_reel(self.video(), "EXACT")["code"], "EXACT")

    def test_neighbor_ignored(self):
        with self.assertRaises(ValueError):
            reel.extract_reel({"code": "EXACT", "neighbor": self.video("OTHER")}, "EXACT")

    def test_nested_exact_record(self):
        self.assertIn("owned.mp4", reel.extract_reel({"code": "EXACT", "post": self.video()}, "EXACT")["video"])

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
        self.assertIn("large.mp4", reel.extract_reel(record, "EXACT")["video"])

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
