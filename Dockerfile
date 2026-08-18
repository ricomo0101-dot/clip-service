FROM node:20-slim

# Systemabhängigkeiten: ffmpeg (Schnitt), python3+pip (yt-dlp), curl/unzip (Deno-Installer),
# ca-certificates. Deno ist 2026 nötig, damit yt-dlp die YouTube-"n-challenge" löst.
# WICHTIG: --pre installiert die yt-dlp NIGHTLY-Version. Die enthält YouTube-Fixes oft
# Tage vor der stabilen Version — nötig gegen die aktuellen 403-Wellen.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --pre "yt-dlp[default]" \
 && yt-dlp --version \
 && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
 && deno --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
