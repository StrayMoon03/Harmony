"""Validate a candidate Netscape cookie jar without persisting or printing it.

Stdout contains a result code and bounded diagnostic metadata. Browser text,
URLs, identities, cookie names/values, and exceptions are never returned.
"""
import json
import os
import re
import sys
import time
from urllib.parse import urlparse


SERVICE_CONFIG = {
    "instagram": {
        "domains": ("instagram.com",),
        "required": {"sessionid", "csrftoken"},
        "url": "https://www.instagram.com/accounts/edit/",
    },
    "threads": {
        "domains": ("threads.net", "threads.com"),
        "required": {"sessionid", "csrftoken"},
        "url": "https://www.threads.net/",
    },
    "facebook": {
        "domains": ("facebook.com", "fb.com"),
        "required": {"c_user", "xs"},
        "url": "https://www.facebook.com/me",
    },
    "youtube": {
        "domains": ("youtube.com", "google.com"),
        "required": {"LOGIN_INFO"},
        "url": "https://www.youtube.com/feed/you",
    },
}


def normalize_instagram_username(value):
    if not isinstance(value, str):
        return None
    username = value.strip().removeprefix("@").lower()
    if not re.fullmatch(r"[a-z0-9._]{1,30}", username):
        return None
    return username


def parse_netscape_candidate_result(service, contents, now=None):
    config = SERVICE_CONFIG.get(service)
    if not config or not isinstance(contents, str):
        return None, "INVALID_FORMAT"
    lines = contents.lstrip("\ufeff").splitlines()
    header_index = next((index for index, raw in enumerate(lines)
                         if raw.strip() in ("# Netscape HTTP Cookie File", "# HTTP Cookie File")), None)
    if header_index is None:
        return None, "INVALID_FORMAT"
    allowed = config["domains"]
    cookies = []
    names = set()
    current_time = now if now is not None else time.time()
    malformed_cookie_rows = False
    for raw in lines[header_index + 1:]:
        line = raw.strip()
        if not line:
            continue
        http_only = line.startswith("#HttpOnly_")
        if line.startswith("#") and not http_only:
            continue
        if http_only:
            line = line[len("#HttpOnly_"):]
        parts = line.split("\t")
        if len(parts) != 7:
            malformed_cookie_rows = True
            continue
        domain, include_subdomains, cookie_path, secure, expires, name, value = parts
        normalized_domain = domain.lstrip(".").lower()
        if not any(normalized_domain == base or normalized_domain.endswith("." + base) for base in allowed):
            continue
        try:
            expiry = int(expires)
        except ValueError:
            continue
        if not name or (expiry > 0 and expiry < current_time):
            continue
        cookies.append({
            "name": name,
            "value": value,
            "domain": domain if domain.startswith(".") else "." + domain,
            "path": cookie_path or "/",
            "secure": secure.upper() == "TRUE",
            "httpOnly": http_only,
            "expires": expiry if expiry > 0 else -1,
            "sameSite": "Lax",
        })
        names.add(name)
    has_required = config["required"].issubset(names)
    has_youtube_auth_cookie = service != "youtube" or bool(names.intersection({"SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"}))
    if not has_required or not has_youtube_auth_cookie:
        for cookie in cookies:
            cookie["value"] = ""
        cookies.clear()
        if malformed_cookie_rows and not names:
            return None, "INVALID_FORMAT"
        return None, "MISSING_REQUIRED_COOKIES"
    return cookies, "OK"


def parse_netscape_candidate(service, contents, now=None):
    cookies, status = parse_netscape_candidate_result(service, contents, now)
    return cookies if status == "OK" else None


def path_is_auth_challenge(url):
    path = urlparse(url).path.lower()
    return any(part in path for part in ("/checkpoint", "/challenge", "/accounts/suspended"))


def classify_browser_result(service, final_url, signals, expected_username=None):
    if path_is_auth_challenge(final_url) or signals.get("checkpoint") is True:
        return "OWNER_REQUIRED"
    if signals.get("login_form") is True or signals.get("login_route") is True:
        return "UNAUTHENTICATED"
    host = (urlparse(final_url).hostname or "").lower()
    trusted_hosts = {
        "instagram": ("instagram.com",),
        "threads": ("threads.net", "threads.com"),
        "facebook": ("facebook.com", "fb.com"),
        "youtube": ("youtube.com",),
    }.get(service, ())
    if not any(host == domain or host.endswith("." + domain) for domain in trusted_hosts):
        return "INCONCLUSIVE"
    if service == "instagram" and signals.get("instagram_edit_form") is True:
        expected = normalize_instagram_username(expected_username)
        observed = normalize_instagram_username(signals.get("instagram_username"))
        if expected is None or observed is None:
            return "IDENTITY_UNVERIFIABLE"
        if observed != expected:
            return "IDENTITY_MISMATCH"
        return "AUTHENTICATED"
    authenticated = {
        "instagram": False,
        "threads": signals.get("account_menu") is True,
        "facebook": signals.get("facebook_account_menu") is True,
        "youtube": signals.get("youtube_account_avatar") is True,
    }.get(service, False)
    if authenticated:
        return "AUTHENTICATED"
    return "INCONCLUSIVE"


def document_category(service, url):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    route = parsed.path.rstrip("/")
    if host == "accounts.google.com":
        return "google_sign_in"
    if not any(host == base or host.endswith("." + base) for base in SERVICE_CONFIG[service]["domains"]):
        return "external"
    if path_is_auth_challenge(url):
        return "challenge"
    if re.search(r"/(?:accounts/login|login|signin)(?:/|$)", route, re.I):
        return "login"
    if service == "instagram" and route == "/accounts/edit":
        return "instagram_edit"
    if service == "youtube" and route.startswith("/feed/"):
        return "youtube_feed"
    if service == "threads":
        return "threads_net" if host.endswith("threads.net") else "threads_com"
    return "provider_other"


def append_navigation_response(service, page, response, diagnostics):
    request = response.request
    # Only the main document. Subresources and iframe URLs are irrelevant.
    if not request.is_navigation_request():
        return
    try:
        if request.frame != page.main_frame:
            return
    except Exception:
        return
    navigation = diagnostics["navigation"]
    if len(navigation) == 8:
        navigation.pop(0)
    navigation.append([response.status, document_category(service, response.url)])


def evidence_category(service, outcome, signals):
    if outcome == "OWNER_REQUIRED":
        return "challenge_detected"
    if outcome == "UNAUTHENTICATED":
        return "login_detected"
    if service == "instagram":
        if outcome == "IDENTITY_MISMATCH":
            return "username_mismatch"
        if outcome == "IDENTITY_UNVERIFIABLE":
            return "username_unreadable"
        return "username_match" if outcome == "AUTHENTICATED" else "edit_form_missing"
    if service == "youtube":
        if not signals["youtube_feed"]:
            return "youtube_feed_missing"
        if not signals["youtube_avatar_present"]:
            return "avatar_evidence_missing"
        return "youtube_sign_in_link_present" if signals["youtube_sign_in_link"] else "avatar_found"
    if service == "threads":
        return "account_menu_found" if signals["account_menu"] else "account_menu_missing"
    return "account_menu_found" if signals["facebook_account_menu"] else "account_menu_missing"


def inspect_with_browser(service, cookies, diagnostics):
    diagnostics["stage"] = "browser_import"
    from playwright.sync_api import sync_playwright
    from chromiumExecutable import chromium_launch_kwargs

    diagnostics["stage"] = "browser_launch"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            **chromium_launch_kwargs(playwright)
        )
        diagnostics["stage"] = "cookie_setup"
        context = browser.new_context(locale="en-US")
        context.add_cookies(cookies)
        page = context.new_page()
        page.on("response", lambda response: append_navigation_response(service, page, response, diagnostics))
        diagnostics["stage"] = "navigation"
        page.goto(SERVICE_CONFIG[service]["url"], wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(1500)
        current_url = page.url
        diagnostics["stage"] = "page_inspection"
        diagnostics["document"] = document_category(service, current_url)
        signals = {
            "checkpoint": path_is_auth_challenge(current_url),
            "login_route": bool(re.search(r"/(?:accounts/login|login|signin)(?:/|$)", urlparse(current_url).path, re.I)),
            "login_form": page.locator('input[type="password"]').count() > 0,
            "instagram_edit_form": False,
            "instagram_username": None,
            "account_menu": False,
            "facebook_account_menu": False,
            "youtube_account_avatar": False,
        }
        if service == "instagram":
            username_inputs = page.locator('input[name="username"], input[autocomplete="username"]')
            has_edit_form = (
                urlparse(current_url).hostname in ("www.instagram.com", "instagram.com")
                and urlparse(current_url).path.rstrip("/") == "/accounts/edit"
                and username_inputs.count() > 0
            )
            if has_edit_form:
                signals["instagram_edit_form"] = True
                try:
                    username = username_inputs.first.input_value(timeout=5000)
                    signals["instagram_username"] = username
                except Exception:
                    pass
        elif service == "threads":
            signals["account_menu"] = page.get_by_role("link", name=re.compile(r"^(log out|logout|switch accounts)$", re.I)).count() > 0
            if not signals["account_menu"]:
                signals["account_menu"] = page.get_by_role("button", name=re.compile(r"^(log out|logout|switch accounts)$", re.I)).count() > 0
        elif service == "facebook":
            signals["facebook_account_menu"] = page.locator('[aria-label="Your profile"], [aria-label="Account"], [data-pagelet="ProfileCometLoggedInNavigationBar"]').count() > 0
        elif service == "youtube":
            signals["youtube_feed"] = (
                urlparse(current_url).hostname in ("www.youtube.com", "youtube.com")
                and urlparse(current_url).path.startswith("/feed/")
            )
            signals["youtube_avatar_present"] = signals["youtube_feed"] and (
                page.locator('ytd-topbar-menu-button-renderer #avatar-btn img, button#avatar-btn img').count() > 0
            )
            signals["youtube_sign_in_link"] = signals["youtube_avatar_present"] and (
                page.locator('a[href*="ServiceLogin"], a[href^="/signin"]').count() > 0
            )
            signals["youtube_account_avatar"] = signals["youtube_avatar_present"] and not signals["youtube_sign_in_link"]
        status = classify_browser_result(
            service,
            current_url,
            signals,
            expected_username=os.environ.get("INSTAGRAM_EXPECTED_USERNAME") if service == "instagram" else None,
        )
        diagnostics["evidence"] = evidence_category(service, status, signals)
        context.close()
        browser.close()
        diagnostics["stage"] = "complete"
        return status


def validate(service, contents, diagnostics=None):
    if diagnostics is None:
        diagnostics = {"stage": "cookie_parse", "navigation": []}
    cookies, parse_status = parse_netscape_candidate_result(service, contents)
    if parse_status != "OK":
        return parse_status
    try:
        return inspect_with_browser(service, cookies, diagnostics)
    except Exception as error:
        diagnostics["error"] = "timeout" if type(error).__name__ == "TimeoutError" else "probe_error"
        return "INCONCLUSIVE"
    finally:
        for cookie in cookies:
            cookie["value"] = ""
        cookies.clear()


def main():
    result = "INCONCLUSIVE"
    diagnostics = {"stage": "cookie_parse", "navigation": []}
    try:
        service = sys.argv[1]
        candidate = sys.stdin.read()
        result = validate(service, candidate, diagnostics)
    except Exception:
        result = "INCONCLUSIVE"
    sys.stdout.write(json.dumps({"status": result, "diagnostics": diagnostics}, separators=(",", ":")))


if __name__ == "__main__":
    main()
