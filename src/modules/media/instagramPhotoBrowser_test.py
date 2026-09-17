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

    def test_rejects_wrong_post_and_incomplete_or_mixed_carousel(self):
        with self.assertRaises(ValueError):
            extract_photos(self.post, "other")
        for change in ({"media_type": 2}, {"image_versions2": {"candidates": []}},
                       {"video_versions": [{}]}):
            post = copy.deepcopy(self.post)
            post["carousel_media"][5].update(change)
            with self.assertRaises(ValueError):
                extract_photos(post, "target")

    def test_exact_url(self):
        self.assertEqual(exact_code("https://www.instagram.com/p/target/?stkn=tracking"), "target")
        for url in ("https://example.com/p/target/", "https://www.instagram.com/reel/target/"):
            with self.assertRaises(ValueError):
                exact_code(url)


if __name__ == "__main__":
    unittest.main()
