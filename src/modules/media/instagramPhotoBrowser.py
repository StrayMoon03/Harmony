import http.cookiejar
import json
import os
import re
import sys
from urllib.parse import urlparse


from chromiumExecutable import chromium_launch_kwargs


def exact_code(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com"):
        raise ValueError("Expected an exact Instagram post URL")
    match = re.fullmatch(r"/(?:[A-Za-z0-9._]+/)?p/([A-Za-z0-9_-]+)/?", parsed.path)
    if not match:
        raise ValueError("Expected an exact Instagram photo post URL")
    return match.group(1)


def allowed_media(url):
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and (parsed.hostname or "").endswith((".cdninstagram.com", ".fbcdn.net")))


def best_url(candidates, key="url"):
    valid = [item for item in candidates if isinstance(item, dict) and allowed_media(item.get(key))]
    valid.sort(key=lambda item: (item.get("width") or 0) * (item.get("height") or 0), reverse=True)
    return valid[0][key] if valid else None


def image_url(item):
    versions = (item.get("image_versions2") or {}).get("candidates") or []
    if not isinstance(versions, list):
        versions = []
    url = best_url(versions)
    if url:
        return url
    resources = item.get("display_resources")
    if isinstance(resources, list):
        url = best_url(resources, key="src")
        if url:
            return url
    display = item.get("display_url")
    return display if allowed_media(display) else None


def video_url(item):
    versions = item.get("video_versions") if isinstance(item.get("video_versions"), list) else []
    url = best_url(versions)
    if url:
        return url
    direct = item.get("video_url")
    return direct if allowed_media(direct) else None


def is_video_item(item):
    return item.get("media_type") == 2 or item.get("is_video") is True or bool(item.get("video_versions") or item.get("video_url"))


def record_items(record):
    carousel = record.get("carousel_media")
    if isinstance(carousel, list) and carousel:
        return carousel
    sidecar = record.get("edge_sidecar_to_children")
    edges = sidecar.get("edges") if isinstance(sidecar, dict) else None
    if isinstance(edges, list) and edges:
        nodes = [edge.get("node") for edge in edges if isinstance(edge, dict) and isinstance(edge.get("node"), dict)]
        if nodes:
            return nodes
    return [record]


def is_post_record(value, code):
    if value.get("code") != code and value.get("shortcode") != code:
        return False
    return bool(value.get("image_versions2") or value.get("carousel_media")
                or value.get("edge_sidecar_to_children") or value.get("video_versions")
                or value.get("video_url") or value.get("display_url"))


def extract_photos(payload, code):
    records = []

    def walk(value):
        if isinstance(value, dict):
            if is_post_record(value, code):
                records.append(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    for record in records:
        raw_items = record_items(record)
        if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= 20:
            continue
        items = []
        photo_only = True
        complete = True
        for item in raw_items:
            if not isinstance(item, dict):
                complete = False
                continue
            if is_video_item(item):
                photo_only = False
                url = video_url(item)
                if url:
                    items.append({"type": "video", "url": url})
                continue
            url = image_url(item)
            if not url:
                complete = False
                continue
            items.append({"type": "image", "url": url})
        if not items:
            continue
        if photo_only and (not complete or len(items) != len(raw_items)):
            continue
        owner = record.get("user") or record.get("owner") or {}
        creator = owner.get("username") if isinstance(owner, dict) else None
        return {
            "code": code,
            "creator": creator,
            "items": items,
            "photos": [item["url"] for item in items if item["type"] == "image"],
        }
    raise ValueError("No complete attachment set matched the requested Instagram post")


def allowed_response(url):
    parsed = urlparse(url)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and parsed.hostname in ("instagram.com", "www.instagram.com", "i.instagram.com")
            and (parsed.path.startswith("/api/") or parsed.path.startswith("/graphql")))


def load_session_cookies(filename):
    jar = http.cookiejar.MozillaCookieJar(filename)
    jar.load(ignore_discard=True, ignore_expires=False)
    return [{"name": c.name, "value": c.value, "domain": c.domain,
             "path": c.path or "/", "secure": c.secure,
             **({"expires": c.expires} if c.expires else {})}
            for c in jar if c.domain.lstrip(".") == "instagram.com"
            or c.domain.endswith(".instagram.com")]


def parse_args(argv):
    args = list(argv[1:])
    use_session = "--session" in args
    args = [arg for arg in args if arg != "--session"]
    if len(args) != 1:
        raise ValueError("Expected one Instagram post URL")
    return args[0], use_session


def parse_json_body(text):
    """Parse an Instagram JSON body, tolerating the `for (;;);` guard and
    newline-separated streamed GraphQL chunks. Returns a list of payloads."""
    if not isinstance(text, str):
        return []
    body = text.strip()
    if body.startswith("for (;;);"):
        body = body[len("for (;;);"):].strip()
    if not body:
        return []
    try:
        return [json.loads(body)]
    except ValueError:
        pass
    payloads = []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payloads.append(json.loads(line))
        except ValueError:
            continue
    return payloads


def _short_text(value, limit=160):
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:limit] if value else None


def response_message(payload):
    """Pull Instagram's human-readable status fields, never tokens or media."""
    if not isinstance(payload, dict):
        return {}
    info = {}
    message = payload.get("message") or payload.get("errorSummary")
    errors = payload.get("errors")
    if not message and isinstance(errors, list) and errors and isinstance(errors[0], dict):
        message = errors[0].get("message") or errors[0].get("summary")
    if _short_text(message):
        info["message"] = _short_text(message)
    if _short_text(payload.get("errorDescription")):
        info["description"] = _short_text(payload.get("errorDescription"))
    for key in ("status", "require_login", "checkpoint_url", "spam", "lock", "feedback_required"):
        if key in payload and isinstance(payload[key], (str, bool, int)):
            info[key] = bool(payload[key]) if key == "checkpoint_url" else payload[key]
    if isinstance(payload.get("data"), dict):
        info["dataFields"] = sorted(payload["data"].keys())[:5]
    return info


def contains_exact_record(value, code):
    if isinstance(value, dict):
        if value.get("code") == code or value.get("shortcode") == code:
            return True
        return any(contains_exact_record(child, code) for child in value.values())
    if isinstance(value, list):
        return any(contains_exact_record(child, code) for child in value)
    return False


def safe_path(url):
    path = urlparse(url).path or "/"
    return path[:100]


def emit_diagnostics(diagnostics):
    print("HARMONY_INSTAGRAM_PHOTO_DIAGNOSTICS:" + json.dumps(diagnostics, sort_keys=True), file=sys.stderr)


def main(diagnostics):
    from playwright.sync_api import sync_playwright
    url, use_session = parse_args(sys.argv)
    code = exact_code(url)
    diagnostics["session"] = use_session
    diagnostics["stage"] = "starting"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**chromium_launch_kwargs(playwright))
        try:
            context = browser.new_context()
            payloads = []
            responses = []
            diagnostics["responses"] = responses
            if use_session:
                # Session pass: only runs after the logged-out pass failed, using
                # Harmony's own Instagram session (the same file gallery-dl uses).
                filename = os.environ.get("INSTAGRAM_COOKIES")
                cookies = load_session_cookies(filename) if filename else []
                names = {cookie["name"] for cookie in cookies}
                diagnostics["cookieCount"] = len(cookies)
                diagnostics["sessionCookiePresent"] = "sessionid" in names
                diagnostics["userIdCookiePresent"] = "ds_user_id" in names
                if not cookies:
                    diagnostics["stage"] = "no_cookies"
                    raise ValueError("Instagram session cookies are unavailable")
                context.add_cookies(cookies)

            def inspect_response(response):
                if not allowed_response(response.url):
                    return
                entry = {"path": safe_path(response.url), "status": response.status}
                try:
                    friendly = response.request.headers.get("x-fb-friendly-name")
                    if friendly:
                        entry["query"] = _short_text(friendly, 80)
                except Exception:
                    pass
                try:
                    text = response.text()
                    entry["guarded"] = text.lstrip().startswith("for (;;);")
                    parsed = parse_json_body(text)
                except Exception:
                    parsed = []
                entry["parsed"] = len(parsed)
                if parsed:
                    entry.update(response_message(parsed[0]))
                    entry["exactRecord"] = contains_exact_record(parsed, code)
                if len(responses) < 20:
                    responses.append(entry)
                if use_session:
                    payloads.extend(parsed)

            context.on("response", inspect_response)
            page = context.new_page()
            diagnostics["stage"] = "navigating"
            page.goto(f"https://www.instagram.com/p/{code}/", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(5000)
            final_path = safe_path(page.url)
            diagnostics["finalPath"] = final_path
            try:
                diagnostics["title"] = _short_text(page.title(), 100)
            except Exception:
                pass
            diagnostics["loginRoute"] = final_path.startswith("/accounts/login")
            diagnostics["checkpointRoute"] = any(part in final_path for part in ("/challenge", "/checkpoint"))
            diagnostics["suspendedOrConsentRoute"] = any(part in final_path for part in ("/accounts/suspended", "/consent", "/age"))
            try:
                landed_code = exact_code(page.url)
            except ValueError:
                landed_code = None
            if landed_code != code:
                diagnostics["stage"] = "redirected"
                raise ValueError("Instagram did not open the requested post")
            script_count = 0
            for text in page.locator('script[type="application/json"]').all_text_contents():
                try:
                    payloads.append(json.loads(text))
                    script_count += 1
                except ValueError:
                    pass
            diagnostics["scriptPayloads"] = script_count
            diagnostics["exactRecordSeen"] = contains_exact_record(payloads, code)
            diagnostics["stage"] = "extracting"
            result = extract_photos(payloads, code)
            diagnostics["stage"] = "ok"
            diagnostics["items"] = len(result["items"])
            print("HARMONY_INSTAGRAM_PHOTOS:" + json.dumps(result))
        finally:
            browser.close()


def run(main_fn=main):
    diagnostics = {}
    try:
        main_fn(diagnostics)
        return 0
    except Exception as error:
        diagnostics.setdefault("error", type(error).__name__)
        if isinstance(error, ValueError):
            diagnostics.setdefault("reason", _short_text(str(error), 120))
        print("Instagram browser could not verify a complete post", file=sys.stderr)
        return 1
    finally:
        emit_diagnostics(diagnostics)


if __name__ == "__main__":
    sys.exit(run())
