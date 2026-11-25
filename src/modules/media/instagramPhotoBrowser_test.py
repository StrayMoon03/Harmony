import copy
import unittest
from instagramPhotoBrowser import exact_code, extract_photos


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


if __name__ == "__main__":
    unittest.main()
