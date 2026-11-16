FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates chromium libatomic1 \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade --pre "yt-dlp[default]" \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade gallery-dl playwright \
    && yt-dlp --version \
    && python3 -m playwright --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
