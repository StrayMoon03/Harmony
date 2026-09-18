"""Exact-record Instagram reel recovery; never select DOM/neighbor video."""
import http.cookiejar
import json
import os
import re
import sys
from urllib.parse import urlparse

DIAGNOSTIC_KEYS = (
    "helperStarted", "playwrightImported", "browserLaunched", "pageCreated",
    "cookiesLoaded", "cookieLoadFailed", "navigationCompleted",
    "requestedPageConfirmed", "loginRoute", "checkpointRoute",
    "inspectResponseSeen", "responseJsonParsed", "responseJsonFailed",
    "exactRecordSeen", "exactVideoDeclared", "allowedVideoCandidateSeen",
    "scriptJsonParsed", "scriptJsonFailed", "helperCompleted",
)


def emit_diagnostics(signals):
    safe = {key: signals.get(key) is True for key in DIAGNOSTIC_KEYS}
    print("HARMONY_INSTAGRAM_DIAGNOSTICS:" + json.dumps(safe), file=sys.stderr)


def record_signals(payload, code, signals):
    if isinstance(payload, dict):
        if payload.get("code") == code or payload.get("shortcode") == code:
            signals["exactRecordSeen"] = True
            if payload.get("media_type") == 2 or payload.get("is_video") is True:
                signals["exactVideoDeclared"] = True
        for child in payload.values():
            record_signals(child, code, signals)
    elif isinstance(payload, list):
        for child in payload:
            record_signals(child, code, signals)


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


def allowed_response(url):
    parsed = urlparse(url)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and parsed.hostname in ("instagram.com", "www.instagram.com", "i.instagram.com")
            and (parsed.path.startswith("/api/") or parsed.path.startswith("/graphql")))


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
    urls = []
    creator = None
    for record in records:
        # Deliberately exclude carousels, quotes and records without video proof.
        carousel = record.get("carousel_media")
        sidecar = record.get("edge_sidecar_to_children")
        edges = sidecar.get("edges") if isinstance(sidecar, dict) else None
        if (isinstance(carousel, list) and carousel) or (isinstance(edges, list) and edges):
            continue
        if record.get("media_type") != 2 and record.get("is_video") is not True:
            continue
        versions = record.get("video_versions")
        versions = versions if isinstance(versions, list) else []
        candidates = [v for v in versions if isinstance(v, dict) and allowed_video(v.get("url"))]
        candidates.sort(key=lambda v: (v.get("width") or 0) * (v.get("height") or 0), reverse=True)
        for url in [record.get("video_url")] + [v["url"] for v in candidates]:
            if allowed_video(url) and url not in urls:
                urls.append(url)
        if urls and creator is None:
            owner = record.get("user") or record.get("owner") or {}
            creator = owner.get("username") if isinstance(owner, dict) else None
            if not isinstance(creator, str) or not re.fullmatch(r"[A-Za-z0-9._]{1,30}", creator):
                creator = None
    if urls:
        return {"code": code, "videos": urls, "creator": creator}
    raise ValueError("No verified exact-record Instagram reel video")


def load_cookies(filename):
    jar = http.cookiejar.MozillaCookieJar(filename)
    jar.load(ignore_discard=True, ignore_expires=False)
    return [{"name": c.name, "value": c.value, "domain": c.domain,
             "path": c.path or "/", "secure": c.secure,
             **({"expires": c.expires} if c.expires else {})}
            for c in jar if c.domain.lstrip(".") == "instagram.com"
            or c.domain.endswith(".instagram.com")]


def main(signals):
    from playwright.sync_api import sync_playwright
    signals["playwrightImported"] = True
    code = reel_code(sys.argv[1])
    result = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])
        signals["browserLaunched"] = True
        try:
            context = browser.new_context()
            filename = os.environ.get("INSTAGRAM_COOKIES")
            if filename:
                try:
                    cookies = load_cookies(filename)
                    context.add_cookies(cookies)
                    signals["cookiesLoaded"] = bool(cookies)
                except (OSError, ValueError, http.cookiejar.LoadError):
                    signals["cookieLoadFailed"] = True
            page = context.new_page()
            signals["pageCreated"] = True

            def inspect_response(response):
                nonlocal result
                if not allowed_response(response.url):
                    return
                signals["inspectResponseSeen"] = True
                try:
                    payload = response.json()
                    signals["responseJsonParsed"] = True
                except Exception:
                    signals["responseJsonFailed"] = True
                    return
                record_signals(payload, code, signals)
                try:
                    candidate = extract_reel(payload, code)
                    signals["allowedVideoCandidateSeen"] = True
                    if result is None:
                        result = candidate
                    else:
                        for url in candidate["videos"]:
                            if url not in result["videos"]:
                                result["videos"].append(url)
                except Exception:
                    pass

            page.on("response", inspect_response)
            page.goto(f"https://www.instagram.com/reel/{code}/", wait_until="domcontentloaded", timeout=30000)
            signals["navigationCompleted"] = True
            page.wait_for_timeout(5000)
            signals["loginRoute"] = "/accounts/login" in urlparse(page.url).path
            signals["checkpointRoute"] = any(part in urlparse(page.url).path for part in ("/checkpoint", "/challenge"))
            if reel_code(page.url) != code:
                raise ValueError("Instagram redirected away from requested reel")
            signals["requestedPageConfirmed"] = True
            if result is None:
                payloads = []
                for text in page.locator('script[type="application/json"]').all_text_contents():
                    try:
                        payload = json.loads(text)
                        payloads.append(payload)
                        signals["scriptJsonParsed"] = True
                        record_signals(payload, code, signals)
                    except ValueError:
                        signals["scriptJsonFailed"] = True
                result = extract_reel(payloads, code)
            signals["allowedVideoCandidateSeen"] = True
            print("HARMONY_INSTAGRAM_REEL:" + json.dumps(result))
            signals["helperCompleted"] = True
        finally:
            browser.close()


def run(main_fn=main):
    signals = {"helperStarted": True}
    try:
        main_fn(signals)
        return 0
    except Exception:
        print("Instagram browser could not verify the requested reel", file=sys.stderr)
        return 1
    finally:
        emit_diagnostics(signals)


if __name__ == "__main__":
    sys.exit(run())
