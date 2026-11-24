FROM node:24-bookworm-slim

# Playwright's driver and its bundled Chromium must stay in lockstep.
# Helpers fall back to apt Chromium only when the bundled browser is missing.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates chromium libatomic1 fonts-dejavu-core \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade --pre "yt-dlp[default]" \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade gallery-dl playwright "Pillow==13.0.0" \
    && python3 -m playwright install --with-deps chromium \
    && yt-dlp --version \
    && python3 -m playwright --version \
    && python3 -c "from playwright.sync_api import sync_playwright; import subprocess; playwright = sync_playwright().start(); executable = playwright.chromium.executable_path; print('playwright-chromium:', executable); print(subprocess.check_output([executable, '--version'], text=True).strip()); playwright.stop(); print('apt-chromium:', subprocess.check_output(['/usr/bin/chromium', '--version'], text=True).strip())" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
