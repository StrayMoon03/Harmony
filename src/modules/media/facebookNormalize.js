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
