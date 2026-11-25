import copy
import unittest
import os
import tempfile
import contextlib
import io
import json
from instagramPhotoBrowser import (allowed_response, contains_exact_record, exact_code, extract_photos,
                                    load_session_cookies, parse_args, parse_json_body, response_message, run)


class PhotoExtractionTests(unittest.TestCase):
    def setUp(self):
        self.post = {"code": "target", "image_versions2": {"candidates": []},
                     "carousel_media": [{"media_type": 1, "image_versions2": {"candidates": [
                         {"width": 100, "height": 100, "url": f"https://a.cdninstagram.com/{i}-small.jpg"},
                         {"width": 1000, "height": 1000, "url": f"https://a.cdninstagram.com/{i}.jpg"}]}}
                                        for i in range(14)]}

    def test_exact_nested_carousel_in_order(self):
        result = extract_photos({"code": "target", "wrapper": self.post}, "target")
        self.assertEqual(result["photos"], [f"https://a.cdninstagram.com/{i}.jpg" for i in range(14)])
        self.assertEqual([item["type"] for item in result["items"]], ["image"] * 14)

    def test_rejects_wrong_post_and_incomplete_photo_carousel(self):
        with self.assertRaises(ValueError):
            extract_photos(self.post, "other")
        post = copy.deepcopy(self.post)
        post["carousel_media"][5]["image_versions2"] = {"candidates": []}
        with self.assertRaises(ValueError):
            extract_photos(post, "target")

    def test_accepts_mixed_photo_and_video_carousel_in_order(self):
        post = copy.deepcopy(self.post)
        post["carousel_media"][5] = {
            "media_type": 2,
            "video_versions": [
                {"width": 100, "height": 100, "url": "https://a.cdninstagram.com/5-small.mp4"},
                {"width": 1000, "height": 1000, "url": "https://a.cdninstagram.com/5.mp4"},
            ],
            "image_versions2": {"candidates": [{"width": 1000, "height": 1000, "url": "https://a.cdninstagram.com/5-poster.jpg"}]},
        }
        result = extract_photos(post, "target")
        self.assertEqual(result["items"][5], {"type": "video", "url": "https://a.cdninstagram.com/5.mp4"})
        self.assertEqual([item["type"] for item in result["items"]], ["image"] * 5 + ["video"] + ["image"] * 8)
        self.assertEqual(len(result["photos"]), 13)
        self.assertNotIn("https://a.cdninstagram.com/5.mp4", result["photos"])

    def test_mixed_carousel_keeps_photos_when_a_video_url_is_missing(self):
        post = copy.deepcopy(self.post)
        post["carousel_media"][5] = {"media_type": 2, "video_versions": [{}]}
        result = extract_photos(post, "target")
        self.assertEqual(len(result["items"]), 13)
        self.assertTrue(all(item["type"] == "image" for item in result["items"]))
        self.assertNotIn("https://a.cdninstagram.com/5.jpg", result["photos"])

    def test_accepts_graphql_sidecar_mixed_carousel(self):
        post = {
            "shortcode": "target",
            "edge_sidecar_to_children": {
                "edges": [
                    {"node": {"is_video": False, "display_url": "https://a.cdninstagram.com/0.jpg"}},
                    {"node": {"is_video": True, "video_url": "https://scontent.cdninstagram.com/1.mp4"}},
                    {"node": {"is_video": False, "display_resources": [
                        {"width": 200, "height": 200, "src": "https://a.cdninstagram.com/2-small.jpg"},
                        {"width": 1200, "height": 1200, "src": "https://a.cdninstagram.com/2.jpg"},
                    ]}},
                ]
            },
        }
        result = extract_photos(post, "target")
        self.assertEqual(result["items"], [
            {"type": "image", "url": "https://a.cdninstagram.com/0.jpg"},
            {"type": "video", "url": "https://scontent.cdninstagram.com/1.mp4"},
            {"type": "image", "url": "https://a.cdninstagram.com/2.jpg"},
        ])

    def test_exact_url(self):
        self.assertEqual(exact_code("https://www.instagram.com/p/target/?stkn=tracking"), "target")
        for url in ("https://example.com/p/target/", "https://www.instagram.com/reel/target/"):
            with self.assertRaises(ValueError):
                exact_code(url)


class SessionPassTests(unittest.TestCase):
    def test_parse_args_session_flag(self):
        self.assertEqual(parse_args(["helper", "https://www.instagram.com/p/target/"]), ("https://www.instagram.com/p/target/", False))
        self.assertEqual(parse_args(["helper", "https://www.instagram.com/p/target/", "--session"]), ("https://www.instagram.com/p/target/", True))
        with self.assertRaises(ValueError):
            parse_args(["helper"])

    def test_only_instagram_api_responses_are_read(self):
        self.assertTrue(allowed_response("https://www.instagram.com/graphql/query"))
        self.assertTrue(allowed_response("https://www.instagram.com/api/v1/media/1/info/"))
        for url in ("https://example.com/api/v1/x", "http://www.instagram.com/api/v1/x",
                    "https://www.instagram.com/p/target/", "https://scontent.cdninstagram.com/api/x"):
            self.assertFalse(allowed_response(url))

    def test_session_cookies_only_keep_instagram_domains(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write("# Netscape HTTP Cookie File\n")
            handle.write(".instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tfake\n")
            handle.write(".example.com\tTRUE\t/\tTRUE\t4102444800\tother\tfake\n")
            name = handle.name
        try:
            cookies = load_session_cookies(name)
        finally:
            os.unlink(name)
        self.assertEqual([c["name"] for c in cookies], ["sessionid"])
        self.assertEqual(cookies[0]["domain"], ".instagram.com")


class LoggedInResponseTests(unittest.TestCase):
    def test_parses_guarded_and_streamed_graphql_bodies(self):
        self.assertEqual(parse_json_body('for (;;);{"a": 1}'), [{"a": 1}])
        self.assertEqual(parse_json_body('{"data": {"x": 1}}\n{"label": "defer"}\n'), [{"data": {"x": 1}}, {"label": "defer"}])
        self.assertEqual(parse_json_body("<html>"), [])
        self.assertEqual(parse_json_body(""), [])

    def test_guarded_logged_in_web_info_record_is_extracted(self):
        record = {"data": {"xdt_api__v1__media__shortcode__web_info": {"items": [{
            "code": "target", "carousel_media": [
                {"media_type": 1, "image_versions2": {"candidates": [{"width": 10, "height": 10, "url": "https://a.cdninstagram.com/0.jpg"}]}},
                {"media_type": 2, "video_versions": [{"width": 10, "height": 10, "url": "https://a.cdninstagram.com/1.mp4"}]},
            ]}]}}}
        payloads = parse_json_body("for (;;);" + json.dumps(record))
        self.assertTrue(contains_exact_record(payloads, "target"))
        result = extract_photos(payloads, "target")
        self.assertEqual([item["type"] for item in result["items"]], ["image", "video"])

    def test_response_message_keeps_only_status_fields(self):
        info = response_message({"message": "Please wait a few minutes before you try again.", "require_login": True,
                                 "status": "fail", "checkpoint_url": "https://www.instagram.com/challenge/secret/", "token": "x"})
        self.assertEqual(info, {"message": "Please wait a few minutes before you try again.", "require_login": True,
                                "status": "fail", "checkpoint_url": True})
        self.assertEqual(response_message({"errors": [{"message": "nope"}]})["message"], "nope")
        self.assertEqual(response_message({"data": {"b": 1, "a": 2}})["dataFields"], ["a", "b"])

    def test_run_emits_diagnostics_on_failure(self):
        def failing(diagnostics):
            diagnostics["stage"] = "redirected"
            diagnostics["finalPath"] = "/accounts/login/"
            raise ValueError("Instagram did not open the requested post")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(run(failing), 1)
        line = [l for l in err.getvalue().splitlines() if l.startswith("HARMONY_INSTAGRAM_PHOTO_DIAGNOSTICS:")][0]
        data = json.loads(line.split(":", 1)[1])
        self.assertEqual(data["stage"], "redirected")
        self.assertEqual(data["finalPath"], "/accounts/login/")
        self.assertEqual(data["error"], "ValueError")
        self.assertIn("could not verify", err.getvalue())


if __name__ == "__main__":
    unittest.main()
