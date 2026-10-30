import json
import http.cookiejar
import os
import re
import sys
import time
from urllib.parse import urlparse


class InstagramAuthenticationRequired(Exception):
    pass


class InstagramSecurityCheckpoint(Exception):
    pass


def is_login_route(value):
    return bool(re.search(r"/(?:accounts/)?login(?:/|$)", urlparse(value).path, re.IGNORECASE))


def is_checkpoint_route(value):
    path = urlparse(value).path.lower()
    return any(part in path for part in ("/checkpoint", "/challenge", "/accounts/suspended"))


def load_instagram_cookies(filename):
    jar = http.cookiejar.MozillaCookieJar(filename)
    # Browser exports use expiry 0 for session cookies; keep those while
    # excluding positive expiry timestamps that have actually passed.
    jar.load(ignore_discard=True, ignore_expires=True)
    now = int(time.time())
    return [{
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain,
        "path": cookie.path or "/",
        "secure": cookie.secure,
        **({"expires": cookie.expires} if cookie.expires else {}),
    } for cookie in jar
      if (cookie.domain.lstrip(".") == "instagram.com" or cookie.domain.endswith(".instagram.com"))
      and (not cookie.expires or cookie.expires > now)]


def exact_code(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com"):
        raise ValueError("Expected an exact Instagram post URL")
    match = re.fullmatch(r"/(?:[A-Za-z0-9._]+/)?p/([A-Za-z0-9_-]+)/?", parsed.path)
    if not match:
        raise ValueError("Expected an exact Instagram photo post URL")
    return match.group(1)


def extract_photos(payload, code):
    records = []

    def walk(value):
        if isinstance(value, dict):
            if value.get("code") == code and value.get("image_versions2"):
                records.append(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    for record in records:
        items = record.get("carousel_media") or [record]
        if not isinstance(items, list) or not 1 <= len(items) <= 20:
            continue
        urls = []
        for item in items:
            if item.get("media_type") != 1 or item.get("video_versions"):
                break
            candidates = sorted((item.get("image_versions2") or {}).get("candidates") or [], key=lambda x: (x.get("width") or 0) * (x.get("height") or 0), reverse=True)
            url = next((x.get("url") for x in candidates if isinstance(x.get("url"), str) and urlparse(x["url"]).scheme == "https" and (urlparse(x["url"]).hostname or "").endswith((".cdninstagram.com", ".fbcdn.net"))), None)
            if not url:
                break
            urls.append(url)
        if len(urls) == len(items):
            return {"code": code, "creator": (record.get("user") or {}).get("username"), "photos": urls}
    raise ValueError("No complete photo-only attachment set matched the requested Instagram post")


def main():
    from playwright.sync_api import sync_playwright
    code = exact_code(sys.argv[1])
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            context = browser.new_context()
            cookie_path = os.environ.get("INSTAGRAM_COOKIES")
            if cookie_path:
                context.add_cookies(load_instagram_cookies(cookie_path))
            page = context.new_page()
            page.goto(f"https://www.instagram.com/p/{code}/", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(5000)
            if is_checkpoint_route(page.url):
                raise InstagramSecurityCheckpoint()
            if is_login_route(page.url):
                raise InstagramAuthenticationRequired()
            if exact_code(page.url) != code:
                raise ValueError("Instagram did not open the requested post")
            payloads = []
            for text in page.locator('script[type="application/json"]').all_text_contents():
                try:
                    payloads.append(json.loads(text))
                except ValueError:
                    pass
            print("HARMONY_INSTAGRAM_PHOTOS:" + json.dumps(extract_photos(payloads, code)))
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except InstagramSecurityCheckpoint:
        print("HARMONY_INSTAGRAM_OWNER_REQUIRED", file=sys.stderr)
        sys.exit(3)
    except InstagramAuthenticationRequired:
        print("HARMONY_INSTAGRAM_AUTH_REQUIRED", file=sys.stderr)
        sys.exit(2)
    except Exception:
        print("Instagram browser could not verify a complete photo post", file=sys.stderr)
        sys.exit(1)
