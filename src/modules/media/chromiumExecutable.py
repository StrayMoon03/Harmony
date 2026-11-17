"""Resolve the Chromium binary used by Harmony's Playwright helpers."""

import os
import sys

APT_CHROMIUM_PATHS = (
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
)


def _is_executable(path):
    return isinstance(path, (str, bytes, os.PathLike)) and os.path.isfile(path) and os.access(path, os.X_OK)


def _normalize(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return os.path.abspath(path)


def _is_apt_default(path):
    if not path:
        return False
    wanted = _normalize(path)
    return any(
        wanted == _normalize(candidate) or os.path.normpath(path) == os.path.normpath(candidate)
        for candidate in APT_CHROMIUM_PATHS
    )


def bundled_playwright_executable(playwright=None):
    if playwright is None:
        return None
    path = getattr(getattr(playwright, "chromium", None), "executable_path", None)
    return path if _is_executable(path) else None


def resolve_chromium_executable(playwright=None):
    """Prefer Playwright's matched browser; keep apt Chromium as a fallback.

    A custom CHROMIUM_PATH still wins when it points at an existing binary
    that is not the historical apt default. CHROMIUM_PATH=/usr/bin/chromium
    is treated as that old default so leftover Railway env values do not
    pin helpers to Debian Chromium after the bundled browser is installed.
    """
    bundled = bundled_playwright_executable(playwright)
    override = str(os.environ.get("CHROMIUM_PATH") or "").strip()
    if _is_executable(override) and not _is_apt_default(override):
        return override
    if bundled:
        return bundled
    if _is_executable(override):
        return override
    for path in APT_CHROMIUM_PATHS:
        if _is_executable(path):
            return path
    return override or bundled or "/usr/bin/chromium"


def chromium_launch_kwargs(playwright, extra_args=None):
    executable = resolve_chromium_executable(playwright)
    print(f"Harmony Chromium executable: {executable}", file=sys.stderr)
    kwargs = {
        "headless": True,
        "args": list(extra_args or ["--no-sandbox", "--disable-dev-shm-usage"]),
    }
    if executable:
        kwargs["executable_path"] = executable
    return kwargs
