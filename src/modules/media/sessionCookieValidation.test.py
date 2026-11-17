import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch


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

    def test_netscape_headers_comments_and_both_newline_styles_are_accepted(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                jar = newline.join([
                    "# Exported by a browser extension",
                    "# Netscape HTTP Cookie File",
                    "# additional harmless comment",
                    cookie_line(".facebook.com", "c_user", "private-id"),
                    cookie_line(".facebook.com", "xs", "private-session"),
                ])
                parsed, status = validator.parse_netscape_candidate_result("facebook", jar)
                self.assertEqual(status, "OK")
                self.assertEqual({item["name"] for item in parsed}, {"c_user", "xs"})

    def test_facebook_missing_required_cookie_names_are_classified_without_values(self):
        for present in ("c_user", "xs"):
            jar = "# Netscape HTTP Cookie File\n" + cookie_line(".facebook.com", present, "PRIVATE_VALUE")
            parsed, status = validator.parse_netscape_candidate_result("facebook", jar)
            self.assertIsNone(parsed)
            self.assertEqual(status, "MISSING_REQUIRED_COOKIES")
        self.assertEqual(validator.validate("facebook", "# Netscape HTTP Cookie File\nnot-a-cookie-row"), "INVALID_FORMAT")

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
            {"instagram_edit_form": True, "instagram_username": "MissHarmony"}, "@missharmony",
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

    def test_instagram_identity_must_match_expected_username_case_insensitively_with_optional_at(self):
        self.assertEqual(validator.normalize_instagram_username(" @Miss.Harmony_7 "), "miss.harmony_7")
        self.assertEqual(validator.classify_browser_result(
            "instagram", "https://www.instagram.com/accounts/edit/",
            {"instagram_edit_form": True, "instagram_username": "@MiSsHaRmOnY"}, "missharmony",
        ), "AUTHENTICATED")
        self.assertEqual(validator.classify_browser_result(
            "instagram", "https://www.instagram.com/accounts/edit/",
            {"instagram_edit_form": True, "instagram_username": "personal_account"}, "missharmony",
        ), "IDENTITY_MISMATCH")

    def test_instagram_identity_fails_closed_when_expected_or_observed_name_is_missing_or_invalid(self):
        edit_url = "https://www.instagram.com/accounts/edit/"
        self.assertEqual(validator.classify_browser_result(
            "instagram", edit_url, {"instagram_edit_form": True, "instagram_username": "missharmony"}, None,
        ), "IDENTITY_UNVERIFIABLE")
        self.assertEqual(validator.classify_browser_result(
            "instagram", edit_url, {"instagram_edit_form": True, "instagram_username": ""}, "missharmony",
        ), "IDENTITY_UNVERIFIABLE")
        self.assertEqual(validator.classify_browser_result(
            "instagram", edit_url, {"instagram_edit_form": True, "instagram_username": "missharmony"}, "bad/name",
        ), "IDENTITY_UNVERIFIABLE")

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

    def test_instagram_diagnostics_distinguish_checkpoint_from_both_identity_failures(self):
        edit_url = "https://www.instagram.com/accounts/edit/"
        for url, username, expected_status, expected_evidence in (
            ("https://www.instagram.com/challenge/private-identifier", None, "OWNER_REQUIRED", "challenge_detected"),
            (edit_url, "other_account", "IDENTITY_MISMATCH", "username_mismatch"),
            (edit_url, "", "IDENTITY_UNVERIFIABLE", "username_unreadable"),
        ):
            signals = {"instagram_edit_form": True, "instagram_username": username}
            result = validator.classify_browser_result("instagram", url, signals, "expected.account")
            self.assertEqual(result, expected_status)
            self.assertEqual(validator.evidence_category("instagram", result, signals), expected_evidence)

    def test_youtube_diagnostics_identify_the_missing_requirement(self):
        for feed, avatar, sign_in, evidence in (
            (False, False, False, "youtube_feed_missing"),
            (True, False, False, "avatar_evidence_missing"),
            (True, True, True, "youtube_sign_in_link_present"),
        ):
            signals = {"youtube_feed": feed, "youtube_avatar_present": avatar, "youtube_sign_in_link": sign_in}
            self.assertEqual(validator.evidence_category("youtube", "INCONCLUSIVE", signals), evidence)

    def test_threads_diagnostics_report_main_navigation_without_urls(self):
        navigation = {"navigation": []}
        page = SimpleNamespace(main_frame=object())
        for status, url, frame in (
            (301, "https://www.threads.net/?private=query", page.main_frame),
            (200, "https://www.threads.com/@private-account", page.main_frame),
            (200, "https://subresource.example/private", object()),
        ):
            request = SimpleNamespace(is_navigation_request=lambda: True, frame=frame)
            response = SimpleNamespace(status=status, url=url, request=request)
            validator.append_navigation_response("threads", page, response, navigation)
        self.assertEqual(navigation["navigation"], [[301, "threads_net"], [200, "threads_com"]])
        signals = {"account_menu": False}
        result = validator.classify_browser_result("threads", "https://www.threads.com/", signals)
        self.assertEqual(result, "INCONCLUSIVE")
        self.assertEqual(validator.evidence_category("threads", result, signals), "account_menu_missing")

    def test_probe_failure_keeps_stage_and_redacts_exception_text(self):
        jar = "\n".join([
            "# Netscape HTTP Cookie File",
            cookie_line(".threads.com", "sessionid"),
            cookie_line(".threads.com", "csrftoken"),
        ])
        diagnostics = {"stage": "cookie_parse", "navigation": []}

        def fail_navigation(_service, _cookies, details):
            details["stage"] = "navigation"
            raise TimeoutError("private href and account")

        with patch.object(validator, "inspect_with_browser", fail_navigation):
            self.assertEqual(validator.validate("threads", jar, diagnostics), "INCONCLUSIVE")
        self.assertEqual(diagnostics, {"stage": "navigation", "navigation": [], "error": "timeout"})


if __name__ == "__main__":
    unittest.main()
