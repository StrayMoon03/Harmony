import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("sessionCookieValidation.py")
SPEC = importlib.util.spec_from_file_location("session_cookie_validation", MODULE_PATH)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


def cookie_line(domain, name, value="value", expires="0"):
    return f"{domain}\tTRUE\t/\tTRUE\t{expires}\t{name}\t{value}"


class SessionCookieValidationTests(unittest.TestCase):
    def test_parses_only_netscape_cookie_exports_for_the_selected_service(self):
        jar = "\n".join([
            "# Netscape HTTP Cookie File",
            cookie_line(".instagram.com", "sessionid", "secret"),
            cookie_line(".instagram.com", "csrftoken", "secret2"),
            cookie_line(".evil.example", "unrelated", "secret3"),
        ])
        parsed = validator.parse_netscape_candidate("instagram", jar)
        self.assertEqual({item["name"] for item in parsed}, {"sessionid", "csrftoken"})
        self.assertIsNone(validator.parse_netscape_candidate("threads", jar))
        self.assertIsNone(validator.parse_netscape_candidate("instagram", "not a cookie export"))

    def test_expired_required_cookie_is_not_accepted(self):
        jar = "\n".join([
            "# Netscape HTTP Cookie File",
            cookie_line(".instagram.com", "sessionid", expires="1"),
            cookie_line(".instagram.com", "csrftoken"),
        ])
        self.assertIsNone(validator.parse_netscape_candidate("instagram", jar, now=2))

    def test_authenticated_signal_requires_platform_specific_positive_evidence(self):
        self.assertEqual(validator.classify_browser_result(
            "instagram", "https://www.instagram.com/accounts/edit/",
            {"instagram_edit_form": True},
        ), "AUTHENTICATED")
        self.assertEqual(validator.classify_browser_result(
            "threads", "https://www.threads.net/", {"account_menu": True},
        ), "AUTHENTICATED")
        self.assertEqual(validator.classify_browser_result(
            "facebook", "https://www.facebook.com/me", {"facebook_account_menu": True},
        ), "AUTHENTICATED")
        self.assertEqual(validator.classify_browser_result(
            "youtube", "https://www.youtube.com/feed/you", {"youtube_account_avatar": True},
        ), "AUTHENTICATED")
        self.assertEqual(validator.classify_browser_result("instagram", "https://www.instagram.com/", {}), "INCONCLUSIVE")

    def test_checkpoint_and_login_signals_never_count_as_success(self):
        self.assertEqual(validator.classify_browser_result(
            "instagram", "https://www.instagram.com/challenge/", {"instagram_edit_form": True},
        ), "OWNER_REQUIRED")
        self.assertEqual(validator.classify_browser_result(
            "facebook", "https://www.facebook.com/", {"login_form": True, "facebook_account_menu": True},
        ), "UNAUTHENTICATED")

    def test_signed_in_looking_ui_on_an_untrusted_host_is_not_accepted(self):
        self.assertEqual(validator.classify_browser_result(
            "threads", "https://untrusted.example/", {"account_menu": True},
        ), "INCONCLUSIVE")


if __name__ == "__main__":
    unittest.main()
