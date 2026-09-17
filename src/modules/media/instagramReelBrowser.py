"""Exact-record Instagram reel recovery; never select DOM/neighbor video."""
import http.cookiejar
import json
import os
import re
import sys
from urllib.parse import urlparse


def reel_code(url):
    parsed = urlparse(url)
    match = re.fullmatch(r"/(?:[A-Za-z0-9._]+/)?(?:reel|reels|p)/([A-Za-z0-9_-]+)/?", parsed.path)
    if (parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com")
            or parsed.username or parsed.password or parsed.port not in (None, 443) or not match):
        raise ValueError("Expected an exact Instagram reel URL")
    return match.group(1)


def allowed_video(url):
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and (parsed.hostname or "").endswith((".cdninstagram.com", ".fbcdn.net")))


def extract_reel(payload, code):
    records = []

    def walk(value):
        if isinstance(value, dict):
            if value.get("code") == code or value.get("shortcode") == code:
                records.append(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    for record in records:
        # Deliberately exclude carousels, quotes and records without video proof.
        if record.get("carousel_media") or record.get("edge_sidecar_to_children"):
            continue
        if record.get("media_type") != 2 and record.get("is_video") is not True:
            continue
        versions = record.get("video_versions")
        versions = versions if isinstance(versions, list) else []
        candidates = [v for v in versions if isinstance(v, dict) and allowed_video(v.get("url"))]
        candidates.sort(key=lambda v: (v.get("width") or 0) * (v.get("height") or 0), reverse=True)
        url = candidates[0]["url"] if candidates else record.get("video_url")
        if allowed_video(url):
            owner = record.get("user") or record.get("owner") or {}
            creator = owner.get("username") if isinstance(owner, dict) else None
            if not isinstance(creator, str) or not re.fullmatch(r"[A-Za-z0-9._]{1,30}", creator):
                creator = None
            return {"code": code, "video": url, "creator": creator}
    raise ValueError("No verified exact-record Instagram reel video")


def load_cookies(filename):
    jar = http.cookiejar.MozillaCookieJar(filename)
    jar.load(ignore_discard=True, ignore_expires=False)
    return [{"name": c.name, "value": c.value, "domain": c.domain,
             "path": c.path or "/", "secure": c.secure,
             **({"expires": c.expires} if c.expires else {})}
            for c in jar if c.domain.lstrip(".") == "instagram.com"
            or c.domain.endswith(".instagram.com")]


def main():
    from playwright.sync_api import sync_playwright
    code = reel_code(sys.argv[1])
    result = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            context = browser.new_context()
            filename = os.environ.get("INSTAGRAM_COOKIES")
            if filename:
                try:
                    context.add_cookies(load_cookies(filename))
                except (OSError, ValueError, http.cookiejar.LoadError):
                    pass  # Public recovery remains possible; never log credentials.
            page = context.new_page()

            def inspect_response(response):
                nonlocal result
                parsed = urlparse(response.url)
                if parsed.hostname not in ("instagram.com", "www.instagram.com"):
                    return
                if "/graphql" not in parsed.path and "/api/" not in parsed.path:
                    return
                try:
                    candidate = extract_reel(response.json(), code)
                    if result is None:
                        result = candidate
                except Exception:
                    pass

            page.on("response", inspect_response)
            page.goto(f"https://www.instagram.com/reel/{code}/", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(5000)
            if reel_code(page.url) != code:
                raise ValueError("Instagram redirected away from requested reel")
            if result is None:
                payloads = []
                for text in page.locator('script[type="application/json"]').all_text_contents():
                    try:
                        payloads.append(json.loads(text))
                    except ValueError:
                        pass
                result = extract_reel(payloads, code)
            print("HARMONY_INSTAGRAM_REEL:" + json.dumps(result))
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Instagram browser could not verify the requested reel", file=sys.stderr)
        sys.exit(1)
