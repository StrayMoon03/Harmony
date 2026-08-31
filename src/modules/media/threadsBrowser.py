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


def document_permalink(page):
    """Use only this document's own URL, canonical link, and og:url.

    Never scan every /post/ anchor on the page — those include
    recommended posts, replies, and quoted posts.
    """
    values = page.evaluate(
        """() => {
          const values = [];
          if (location.href) values.push(location.href);
          const canonical = document.querySelector('link[rel="canonical"]');
          const ogUrl = document.querySelector('meta[property="og:url"]');
          if (canonical && canonical.href) values.push(canonical.href);
          if (ogUrl && ogUrl.content) values.push(ogUrl.content);
          return values;
        }"""
    )
    for value in values or []:
        exact = canonical_post_url(value)
        if exact:
            return exact
    return None


def wait_for_permalink(page, timeout_ms=10000):
    deadline = time.time() + (timeout_ms / 1000.0)
    found = document_permalink(page)
    while found is None and time.time() < deadline:
        page.wait_for_timeout(500)
        found = document_permalink(page)
    return found


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
            mirrored = []
            seen = set()
            for item in cookies:
                variants = [item]
                domain = item.get("domain") or ""
                if "threads.com" in domain.lower() and "threads.net" not in domain.lower():
                    twin = dict(item)
                    twin["domain"] = domain.replace("threads.com", "threads.net").replace(
                        "THREADS.COM", "threads.net"
                    )
                    variants.append(twin)
                elif "threads.net" in domain.lower():
                    twin = dict(item)
                    twin["domain"] = domain.replace("threads.net", "threads.com")
                    variants.append(twin)
                for variant in variants:
                    key = (
                        variant.get("name"),
                        variant.get("domain"),
                        variant.get("path", "/"),
                    )
                    if key in seen:
                        continue
                    seen.add(key)
                    mirrored.append(variant)
            context.add_cookies(mirrored)

        page = context.new_page()

        page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3000)

        exact_post_url = canonical_post_url(target_url) or document_permalink(page)
        if exact_post_url is None:
            page.mouse.wheel(0, 400)
            exact_post_url = wait_for_permalink(page, timeout_ms=10000)

        # A /share/ URL is not a post identity. If hydration never exposes
        # this document's own /@user/post/ID, fail closed instead of
        # scraping neighboring feed media.
        if exact_post_url is None:
            raise RuntimeError(
                "Threads page did not resolve to one verifiable post"
            )

        if canonical_post_url(page.url) != exact_post_url:
            page.goto(exact_post_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(4000)

        # Threads lazy-loads media in its newer div-based post layout.
        page.mouse.wheel(0, 500)
        page.wait_for_timeout(2500)

        exact_path = urlparse(exact_post_url).path.rstrip("/")

        dom_result = page.evaluate(
            """(exactPath) => {
              const results = [];
              const normalizePath = (value) => {
                try { return new URL(value, location.href).pathname.replace(/\\/$/, ''); }
                catch { return ''; }
              };
              const mediaCount = (root) => {
                if (!root) return 0;
                const videos = root.querySelectorAll('video, video source').length;
                const images = [...root.querySelectorAll('img')].filter(
                  (image) => image.naturalWidth >= 300 && image.naturalHeight >= 300
                ).length;
                return videos + images;
              };
              const articles = [...document.querySelectorAll('article')];
              const matched = articles.find((article) =>
                [...article.querySelectorAll('a[href]')].some(
                  (anchor) => normalizePath(anchor.href) === exactPath
                )
              );
              // Never use an arbitrary first article: Threads may place a
              // recommended post there, which caused the prior mismatch.
              let target = matched || null;

              // Threads now frequently renders posts as nested divs without
              // an <article>. Anchor the search to this post's own permalink,
              // then choose the smallest ancestor that contains its media.
              if (!target) {
                const selfLink = [...document.querySelectorAll('a[href]')].find(
                  (anchor) => normalizePath(anchor.href) === exactPath
                );
                let node = selfLink?.parentElement || null;
                for (let depth = 0; node && depth < 12; depth += 1) {
                  if (mediaCount(node) > 0) {
                    target = node;
                    break;
                  }
                  if (node.matches?.('main, body')) break;
                  node = node.parentElement;
                }
              }

              // On an exact post page the root post can omit its own link.
              // Start at the first substantial media element and climb only
              // to its nearest post-sized container, never the entire feed.
              // Never do this on a /share/ or feed URL — pagePath must
              // already be this post's permalink.
              const pagePath = normalizePath(location.href);
              if (!target && pagePath === exactPath) {
                const media = [...document.querySelectorAll('main video, main img')].find(
                  (element) => element.tagName === 'VIDEO' ||
                    (element.naturalWidth >= 300 && element.naturalHeight >= 300)
                );
                let node = media?.parentElement || null;
                let best = null;
                for (let depth = 0; node && depth < 8; depth += 1) {
                  const count = mediaCount(node);
                  if (count > 0 && count <= 20) best = node;
                  if (node.matches?.('main, body') || count > 20) break;
                  node = node.parentElement;
                }
                target = best;
              }
              if (!target) return { media: [], postUrls: [] };

              const postUrls = [...target.querySelectorAll('a[href*="/post/"]')]
                .map((anchor) => anchor.href)
                .filter(Boolean);

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
              return { media: results, postUrls };
            }""",
            exact_path,
        )

        dom_media = (dom_result or {}).get("media", [])
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
