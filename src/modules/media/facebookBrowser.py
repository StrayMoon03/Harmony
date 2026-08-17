#!/usr/bin/env python3
import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import sync_playwright

PREFIX = "HARMONY_FACEBOOK_BROWSER:"
ERROR_PREFIX = "HARMONY_FACEBOOK_BROWSER_ERROR:"

ID_KEYS = {
    "id", "post_id", "story_id", "legacy_story_id",
    "legacy_api_post_id", "video_id", "photo_id", "media_id",
    "pfbid", "story_fbid",
}
URL_KEYS = {
    "permalink_url", "url", "wwwURL", "shareable_url",
    "mobileUri", "mobile_uri",
}
VIDEO_KEYS = (
    "playable_url_quality_hd", "browser_native_hd_url",
    "playable_url", "browser_native_sd_url",
)
ATTACHMENT_WORDS = (
    "attachment", "subattachment", "media", "photo", "video", "image",
)


def load_cookies(cookie_path):
    cookies = []
    health = {"c_user": False, "xs": False}
    if not cookie_path or not os.path.isfile(cookie_path):
        return cookies, "missing"

    now = int(time.time())
    with open(cookie_path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            http_only = False
            if not line:
                continue
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
                http_only = True
            elif line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 7:
                continue
            domain, _, cookie_path_value, secure, expires, name = parts[:6]
            value = "\t".join(parts[6:])
            normalized = domain.lstrip(".").lower()
            if normalized != "facebook.com" and not normalized.endswith(".facebook.com"):
                continue
            try:
                expiry = int(expires)
            except ValueError:
                expiry = 0
            if expiry > 0 and expiry < now:
                continue
            item = {
                "name": name,
                "value": value,
                "domain": domain,
                "path": cookie_path_value or "/",
                "secure": secure.upper() == "TRUE",
                "httpOnly": http_only,
            }
            if expiry > 0:
                item["expires"] = expiry
            cookies.append(item)
            if name in health:
                health[name] = True

    status = "ok" if all(health.values()) else "missing-session-cookies"
    return cookies, status


def identities_from_url(value):
    ids = set()
    try:
        decoded = unquote(value)
        parsed = urlparse(decoded)
        query = parse_qs(parsed.query)
        for key in ("story_fbid", "fbid", "v"):
            for item in query.get(key, []):
                if item:
                    ids.add(str(item))
        patterns = (
            r"/posts/([^/?#]+)", r"/permalink/(\d+)",
            r"/videos/(\d+)", r"/reels?/([^/?#]+)",
            r"/share/[vrp]/([^/?#]+)",
        )
        for pattern in patterns:
            match = re.search(pattern, parsed.path, re.I)
            if match:
                ids.add(match.group(1))
    except Exception:
        pass
    return {item for item in ids if item}


def normalized_text(value):
    if isinstance(value, (str, int)):
        return str(value)
    return ""


def root_score(node, target_ids):
    if not isinstance(node, dict):
        return 0
    score = 0
    for key, value in node.items():
        text = normalized_text(value)
        if not text:
            continue
        if key in ID_KEYS and text in target_ids:
            score = max(score, 120)
        if key in URL_KEYS and any(target in text for target in target_ids):
            score = max(score, 90)
    if score and any(
        any(word in str(key).lower() for word in ATTACHMENT_WORDS)
        for key in node.keys()
    ):
        score += 20
    return score


def candidate_roots(value, target_ids, found):
    if isinstance(value, dict):
        score = root_score(value, target_ids)
        if score:
            try:
                size = len(json.dumps(value, separators=(",", ":")))
            except Exception:
                size = 10**9
            found.append((score, size, value))
        for child in value.values():
            candidate_roots(child, target_ids, found)
    elif isinstance(value, list):
        for child in value:
            candidate_roots(child, target_ids, found)


def valid_media_url(value):
    if not isinstance(value, str) or not value.startswith(("https://", "http://")):
        return None
    try:
        host = (urlparse(value).hostname or "").lower()
    except Exception:
        return None
    if host.endswith(".fbcdn.net") or host.endswith(".cdninstagram.com"):
        return value
    return None


def infer_id(node, inherited):
    for key in ID_KEYS:
        value = node.get(key)
        if isinstance(value, (str, int)) and str(value):
            return str(value)
    return inherited


def first_direct_url(node, keys):
    for key in keys:
        value = node.get(key)
        direct = valid_media_url(value)
        if direct:
            return direct
    return None


def collect_attachments(root):
    ordered = []
    seen = set()

    def add(media_id, media_type, url):
        if not url:
            return
        key = media_id or urlparse(url).path
        compound = f"{media_type}:{key}"
        if compound in seen:
            return
        seen.add(compound)
        ordered.append({
            "mediaId": media_id or None,
            "type": media_type,
            "url": url,
            "order": len(ordered),
        })

    def walk(value, inherited_id=None, inherited_type=None, in_attachment=False):
        if isinstance(value, list):
            for child in value:
                walk(child, inherited_id, inherited_type, in_attachment)
            return
        if not isinstance(value, dict):
            return

        media_id = infer_id(value, inherited_id)
        typename = str(value.get("__typename", "")).lower()
        media_type = inherited_type
        if "video" in typename or any(key in value for key in VIDEO_KEYS):
            media_type = "video"
        elif "photo" in typename or "image" in typename:
            media_type = "photo"

        video_url = first_direct_url(value, VIDEO_KEYS)
        if in_attachment and video_url:
            add(media_id, "video", video_url)

        if in_attachment and media_type != "video":
            for key in ("uri", "src", "url"):
                image_url = valid_media_url(value.get(key))
                if image_url:
                    add(media_id, "photo", image_url)
                    break

        for key, child in value.items():
            lowered = str(key).lower()
            child_attachment = in_attachment or any(
                word in lowered for word in ATTACHMENT_WORDS
            )
            child_type = media_type
            if "video" in lowered:
                child_type = "video"
            elif "photo" in lowered or "image" in lowered:
                child_type = "photo"
            walk(child, media_id, child_type, child_attachment)

    walk(root)
    return ordered[:10]


def creator_from_root(root):
    if not isinstance(root, dict):
        return None
    for key in ("owner", "actors", "author", "creation_story"):
        value = root.get(key)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, dict):
                name = item.get("name") or item.get("username")
                if isinstance(name, str) and name.strip():
                    return name.strip()
    return None


def parse_json_text(text):
    payloads = []
    stripped = (text or "").strip()
    if not stripped:
        return payloads
    try:
        payloads.append(json.loads(stripped))
        return payloads
    except Exception:
        pass
    for line in stripped.splitlines():
        try:
            payloads.append(json.loads(line))
        except Exception:
            continue
    return payloads


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("Facebook URL is required")
    target_url = sys.argv[1]
    cookie_path = sys.argv[2] if len(sys.argv) > 2 else ""
    cookies, cookie_health = load_cookies(cookie_path)
    if cookie_health != "ok":
        raise RuntimeError(f"Facebook cookies are {cookie_health}")

    payloads = []
    final_url = target_url
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            context = browser.new_context(
                viewport={"width": 1280, "height": 1600},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 Chrome/131 Safari/537.36"
                ),
                locale="en-US",
            )
            context.add_cookies(cookies)
            page = context.new_page()

            def record_response(response):
                try:
                    content_type = response.headers.get("content-type", "").lower()
                    if "/api/graphql" not in response.url and "json" not in content_type:
                        return
                    for payload in parse_json_text(response.text()):
                        payloads.append(payload)
                except Exception:
                    pass

            page.on("response", record_response)
            page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(8000)
            page.mouse.wheel(0, 500)
            page.wait_for_timeout(2500)
            final_url = page.url

            lowered_url = final_url.lower()
            body_text = page.locator("body").inner_text(timeout=5000).lower()
            if "/login" in lowered_url or "/checkpoint" in lowered_url:
                raise RuntimeError("Facebook opened a login or checkpoint page")
            if "log in to facebook" in body_text and "create new account" in body_text:
                raise RuntimeError("Facebook session is not logged in")

            for text in page.locator('script[type="application/json"]').all_text_contents():
                payloads.extend(parse_json_text(text))
        finally:
            browser.close()

    target_ids = identities_from_url(target_url) | identities_from_url(final_url)
    if not target_ids:
        raise RuntimeError("Facebook post identity could not be resolved")

    roots = []
    for payload in payloads:
        candidate_roots(payload, target_ids, roots)
    if not roots:
        raise RuntimeError("No GraphQL node matched the requested Facebook post")

    roots.sort(key=lambda item: (-item[0], item[1]))
    score, _, root = roots[0]
    attachments = collect_attachments(root)
    if not attachments:
        raise RuntimeError("Matched Facebook post contained no verified attachments")

    print(PREFIX + json.dumps({
        "finalUrl": final_url,
        "targetIds": sorted(target_ids),
        "matchScore": score,
        "cookieCount": len(cookies),
        "cookieHealth": cookie_health,
        "creator": creator_from_root(root),
        "attachments": attachments,
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(ERROR_PREFIX + str(error), file=sys.stderr)
        sys.exit(1)
