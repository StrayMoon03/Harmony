const fs = require("node:fs/promises");
const path = require("node:path");

async function getFacebookSessionHeader() {
  const cookiePath =
    process.env.FACEBOOK_COOKIES ||
    path.resolve(__dirname, "../../facebook-cookies.txt");
  try {
    const text = await fs.readFile(cookiePath, "utf8");
    const now = Math.floor(Date.now() / 1000);
    const cookies = [];
    const session = { c_user: false, xs: false };

    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#HttpOnly_")) {
        line = line.slice("#HttpOnly_".length);
      } else if (line.startsWith("#")) {
        continue;
      }
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [rawDomain, , , , rawExpiry, name, ...valueParts] = parts;
      const domain = rawDomain.replace(/^\./, "").toLowerCase();
      const expiry = Number(rawExpiry);
      if (
        (domain !== "facebook.com" && !domain.endsWith(".facebook.com")) ||
        (Number.isFinite(expiry) && expiry > 0 && expiry < now)
      ) {
        continue;
      }
      cookies.push(name + "=" + valueParts.join("\t"));
      if (Object.prototype.hasOwnProperty.call(session, name)) {
        session[name] = true;
      }
    }

    const healthy = session.c_user && session.xs;
    console.log("Facebook normalization cookies:", healthy ? "ok" : "missing-session-cookies");
    return healthy ? cookies.join("; ") : "";
  } catch {
    console.log("Facebook normalization cookies: missing");
    return "";
  }
}

/**
 * Facebook share links may redirect anonymous requests to /login while
 * preserving the real post URL in the next= parameter. Never pass the
 * login wrapper to media extractors.
 *
 * @param {string} value
 * @returns {string}
 */
function unwrapFacebookLoginRedirect(value) {
  try {
    const wrapper = new URL(value);
    const host = wrapper.hostname.toLowerCase();
    const isFacebook =
      host === "facebook.com" ||
      host.endsWith(".facebook.com");
    const isLogin =
      wrapper.pathname === "/login" ||
      wrapper.pathname === "/login/" ||
      wrapper.pathname.startsWith("/login.");

    if (!isFacebook || !isLogin) return value;

    const next = wrapper.searchParams.get("next");
    if (!next) return value;

    const target = new URL(next);
    const targetHost = target.hostname.toLowerCase();
    const isFacebookTarget =
      target.protocol === "https:" &&
      (
        targetHost === "facebook.com" ||
        targetHost.endsWith(".facebook.com")
      );

    if (!isFacebookTarget) return value;

    console.log(
      "Facebook login redirect unwrapped to the original post URL."
    );
    return target.toString();
  } catch {
    return value;
  }
}

/**
 * Normalizes common Facebook URLs into a consistent format.
 * Resolves share / fb.watch short links when possible.
 * Rewrites nested pcb video URLs to watch/?v= form for yt-dlp.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function normalizeFacebookUrl(url) {
  let current = url;
  const cookieHeader = await getFacebookSessionHeader();

  try {
    const u = new URL(current);

    if (
      u.hostname === "m.facebook.com" ||
      u.hostname === "facebook.com" ||
      u.hostname === "l.facebook.com"
    ) {
      u.hostname = "www.facebook.com";
    }

    // Unwrap l.facebook.com redirectors
    if (
      u.hostname.includes("facebook.com") &&
      u.pathname === "/l.php" &&
      u.searchParams.get("u")
    ) {
      current = u.searchParams.get("u");
    } else {
      current = u.toString();
    }
  } catch {
    // keep current
  }

  // Nested album video URLs often break extractors:
  // /USER/videos/pcb.ALBUM/VIDEOID → /watch/?v=VIDEOID
  try {
    const pcb = current.match(
      /\/videos\/pcb\.[^/]+\/(\d+)/i
    );
    if (pcb) {
      current = `https://www.facebook.com/watch/?v=${pcb[1]}`;
      console.log(
        `Facebook normalized pcb video URL → ${current}`
      );
    }
  } catch {
    // keep current
  }

  // Plain /videos/NUMERIC (not pcb) → watch form
  try {
    const plain = current.match(
      /facebook\.com\/(?:[^/]+\/)?videos\/(\d+)\/?(?:\?|$)/i
    );
    if (plain && !/\/watch\//i.test(current)) {
      current = `https://www.facebook.com/watch/?v=${plain[1]}`;
      console.log(
        `Facebook normalized videos URL → ${current}`
      );
    }
  } catch {
    // keep current
  }

  try {
    const u = new URL(current);
    const needsResolve =
      u.hostname === "fb.watch" ||
      /\/share\/[vrp]\//i.test(u.pathname) ||
      u.hostname === "l.facebook.com";

    if (needsResolve) {
      try {
        const head = await fetch(current, {
          method: "HEAD",
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        if (head.url) {
          current = unwrapFacebookLoginRedirect(head.url);
        }
      } catch {
        try {
          const get = await fetch(current, {
            method: "GET",
            redirect: "follow",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
          });
          if (get.url) {
            current = unwrapFacebookLoginRedirect(get.url);
          }
        } catch {
          // keep current
        }
      }
    }
  } catch {
    // keep current
  }

  current = unwrapFacebookLoginRedirect(current);

  try {
    const u = new URL(current);

    if (
      u.hostname === "m.facebook.com" ||
      u.hostname === "facebook.com"
    ) {
      u.hostname = "www.facebook.com";
    }

    const drop = [
      "fbclid",
      "ref",
      "refsrc",
      "__tn__",
      "rdid",
      "share_url",
      "mibextid",
    ];
    for (const key of drop) {
      u.searchParams.delete(key);
    }

    if (u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/$/, "");
    }

    return u.toString();
  } catch {
    return current;
  }
}

module.exports = {
  normalizeFacebookUrl,
  unwrapFacebookLoginRedirect,
};
