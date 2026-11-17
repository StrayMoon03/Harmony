import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import chromiumExecutable as chromium


class ChromiumExecutableTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("CHROMIUM_PATH", None)

    def tearDown(self):
        self._env.stop()

    def test_custom_chromium_path_wins_over_bundled_and_apt(self):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            custom = handle.name
        os.chmod(custom, 0o755)
        self.addCleanup(lambda: os.remove(custom))
        os.environ["CHROMIUM_PATH"] = custom
        playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path="/tmp/playwright-chrome"))
        with patch.object(chromium, "_is_executable", side_effect=lambda path: path in {custom, "/tmp/playwright-chrome", "/usr/bin/chromium"}):
            self.assertEqual(chromium.resolve_chromium_executable(playwright), custom)

    def test_apt_default_env_does_not_override_bundled_browser(self):
        os.environ["CHROMIUM_PATH"] = "/usr/bin/chromium"
        bundled = "/ms-playwright/chromium/chrome"
        playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path=bundled))
        with patch.object(chromium, "_is_executable", side_effect=lambda path: path in {bundled, "/usr/bin/chromium"}):
            self.assertEqual(chromium.resolve_chromium_executable(playwright), bundled)

    def test_falls_back_to_apt_chromium_when_bundled_browser_is_missing(self):
        playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path="/missing/playwright-chrome"))
        with patch.object(chromium, "_is_executable", side_effect=lambda path: path == "/usr/bin/chromium"):
            self.assertEqual(chromium.resolve_chromium_executable(playwright), "/usr/bin/chromium")

    def test_launch_kwargs_include_the_resolved_binary_and_default_args(self):
        bundled = "/ms-playwright/chromium/chrome"
        playwright = SimpleNamespace(chromium=SimpleNamespace(executable_path=bundled))
        with patch.object(chromium, "_is_executable", side_effect=lambda path: path == bundled):
            kwargs = chromium.chromium_launch_kwargs(playwright)
        self.assertEqual(kwargs["executable_path"], bundled)
        self.assertTrue(kwargs["headless"])
        self.assertEqual(kwargs["args"], ["--no-sandbox", "--disable-dev-shm-usage"])


if __name__ == "__main__":
    unittest.main()
