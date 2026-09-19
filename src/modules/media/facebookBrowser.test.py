import importlib.util
import pathlib
import sys
import types
import unittest


# Extraction helpers do not launch Playwright in these unit tests.
playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = None
playwright.sync_api = sync_api
sys.modules.setdefault("playwright", playwright)
sys.modules.setdefault("playwright.sync_api", sync_api)

MODULE_PATH = pathlib.Path(__file__).with_name("facebookBrowser.py")
SPEC = importlib.util.spec_from_file_location("facebook_browser", MODULE_PATH)
facebook_browser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(facebook_browser)


class FacebookBrowserExtractionTests(unittest.TestCase):
    def test_collects_modern_progressive_video_and_ignores_its_poster(self):
        root = {
            "id": "exact-post",
            "attachments": [{
                "media": {
                    "id": "owned-video",
                    "videoDeliveryResponseFragment": {
                        "videoDeliveryResponseResult": {
                            "progressive_urls": [{
                                "progressive_url": "https://video-a.fbcdn.net/owned.mp4",
                                "width": 720,
                            }],
                        },
                    },
                    "image": {"uri": "https://image-a.fbcdn.net/poster.jpg"},
                },
            }],
        }

        self.assertEqual(facebook_browser.collect_attachments(root), [{
            "mediaId": "owned-video",
            "type": "video",
            "url": "https://video-a.fbcdn.net/owned.mp4",
            "order": 0,
        }])

    def test_collects_legacy_dash_url_as_a_video_candidate(self):
        root = {
            "attachments": [{
                "media": {
                    "id": "owned-video",
                    "videoDeliveryLegacyFields": {
                        "playable_url_dash": "https://video-a.fbcdn.net/owned.mp4",
                    },
                },
            }],
        }

        self.assertEqual(
            facebook_browser.collect_attachments(root)[0]["type"],
            "video",
        )


if __name__ == "__main__":
    unittest.main()
