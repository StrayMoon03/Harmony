FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip fonts-dejavu-core ca-certificates && python3 -m pip install --no-cache-dir --break-system-packages "Pillow==13.0.0" && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Deliberately no bot entrypoint, private database, admin endpoints or Discord dependencies.
COPY services/public-countdowns ./services/public-countdowns
COPY src/services/concertCountdownModel.js src/services/concertCountdownRender.js src/services/concertTourIdentity.js ./src/services/
COPY src/reference/strayKidsRunItTour.json ./src/reference/
COPY src/renderers/concert_countdown.py ./src/renderers/
ENV NODE_ENV=production PORT=3000 COUNTDOWN_SYNC_PORT=3101 COUNTDOWN_PUBLIC_DIRECTORY=/data/countdowns
CMD ["node", "services/public-countdowns/server.js"]
