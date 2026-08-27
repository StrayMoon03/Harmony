#!/usr/bin/env python3
import json
import os
import sys
import time
import re
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def load_netscape_cookies(cookie_path):
    cookies = []
    if not cookie_path or not os.path.isfile(cookie_path):
        return cookies

    now = int(time.time())
    with open(cookie_path, "r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.strip()
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
            normalized_domain = domain.lstrip(".").lower()
            if not (
                normalized_domain == "threads.com"
                or normalized_domain.endswith(".threads.com")
                or normalized_domain == "threads.net"
                or normalized_domain.endswith(".threads.net")
            ):
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

    return cookies


def allowed_media_url(value):
    if not isinstance(value, str) or not value.startswith(("http://", "https://")):
        return False
    try:
        host = (urlparse(value).hostname or "").lower()
    except ValueError:
        return False
    return (
        host.endswith(".fbcdn.net")
        or host.endswith(".cdninstagram.com")
        or host.endswith(".threads.com")
        or host.endswith(".threads.net")
    )


def canonical_post_url(value):
    if not isinstance(value, str):
        return None
    match = re.search(
        r"https?://(?:www\.)?threads\.(?:com|net)/@[^/?#]+/post/[A-Za-z0-9_-]+",
        value,
        re.IGNORECASE,
    )
    return match.group(0) if match else None


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("Threads URL is required")

    target_url = sys.argv[1]
    cookie_path = sys.argv[2] if len(sys.argv) > 2 else ""
    parsed = urlparse(target_url)
    clean_path = parsed.path.rstrip("/")
    if clean_path.lower().endswith("/media"):
        clean_path = clean_path[:-len("/media")]
    target_url = parsed._replace(path=clean_path, query="", fragment="").geturl()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 1600},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 Chrome/131 Safari/537.36"
            ),
            locale="en-US",
        )

        cookies = load_netscape_cookies(cookie_path)
        if cookies:
            context.add_cookies(cookies)

        page = context.new_page()

        page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(8000)

        identity_candidates = page.evaluate(
            """() => {
              const values = [location.href];
              const canonical = document.querySelector('link[rel="canonical"]');
              const ogUrl = document.querySelector('meta[property="og:url"]');
              if (canonical?.href) values.push(canonical.href);
              if (ogUrl?.content) values.push(ogUrl.content);
              for (const anchor of document.querySelectorAll('a[href*="/post/"]')) {
                values.push(anchor.href);
              }
              return values;
            }"""
        )

        exact_urls = []
        for value in identity_candidates or []:
            exact = canonical_post_url(value)
            if exact and exact not in exact_urls:
                exact_urls.append(exact)

        preferred = []
        for value in (page.url,) + tuple((identity_candidates or [])[:3]):
            exact = canonical_post_url(value)
            if exact and exact not in preferred:
                preferred.append(exact)

        if preferred:
            exact_post_url = preferred[0]
        elif len(exact_urls) == 1:
            exact_post_url = exact_urls[0]
        elif urlparse(target_url).path.lower().startswith("/share/"):
            # Newer Threads share URLs can be the public identity of the
            # post itself instead of redirecting to /@user/post/{code}.
            exact_post_url = target_url
        else:
            raise RuntimeError(
                "Threads page did not resolve to one verifiable post"
            )

        if (
            canonical_post_url(exact_post_url)
            and canonical_post_url(page.url) != exact_post_url
        ):
            page.goto(exact_post_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(6000)

        exact_path = urlparse(exact_post_url).path.rstrip("/")

        dom_media = page.evaluate(
            """(exactPath) => {
              const results = [];
              const normalizePath = (value) => {
                try { return new URL(value, location.href).pathname.replace(/\\/$/, ''); }
                catch { return ''; }
              };
              const articles = [...document.querySelectorAll('article')];
              const matched = articles.find((article) =>
                [...article.querySelectorAll('a[href]')].some(
                  (anchor) => normalizePath(anchor.href) === exactPath
                )
              );
              // The browser is opened on the already-resolved exact post URL.
              // Threads may omit a self-link from the root post, so use the
              // first article (the root post) when no exact self-link exists.
              const target = matched || articles[0] || null;
              if (!target) return [];

              for (const video of target.querySelectorAll("video")) {
                const value = video.currentSrc || video.src;
                if (value) results.push(value);
              }
              for (const source of target.querySelectorAll("video source")) {
                if (source.src) results.push(source.src);
              }
              const seenImages = new Set();
              for (const image of target.querySelectorAll("img")) {
                if (image.naturalWidth < 300 || image.naturalHeight < 300) {
                  continue;
                }
                const value = image.currentSrc || image.src;
                if (!value) continue;

                let parsed;
                try {
                  parsed = new URL(value);
                } catch {
                  continue;
                }
                if (
                  parsed.hostname.startsWith("static.") ||
                  parsed.pathname.includes("/rsrc.php/")
                ) {
                  continue;
                }

                const alt = (image.alt || "").trim().toLowerCase();
                const identity = alt || (
                  parsed.hostname + parsed.pathname
                );
                if (seenImages.has(identity)) continue;
                seenImages.add(identity);
                results.push(value);
              }
              return results;
            }""",
            exact_path,
        )

        final_url = exact_post_url
        title = page.title()
        browser.close()

    ordered = []
    seen = set()
    for value in list(dom_media or []):
        if not allowed_media_url(value) or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
        if len(ordered) >= 40:
            break

    result = {
        "finalUrl": final_url,
        "title": title,
        "cookieCount": len(cookies),
        "candidates": ordered,
    }
    print("HARMONY_THREADS_BROWSER:" + json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            "HARMONY_THREADS_BROWSER_ERROR:" + str(error),
            file=sys.stderr,
        )
        sys.exit(1)
