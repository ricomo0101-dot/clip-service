FROM node:20-slim

# Systemabhängigkeiten: ffmpeg (Schnitt), python3+pip (yt-dlp), curl/unzip (Deno-Installer),
# ca-certificates. Deno ist 2026 nötig, damit yt-dlp die YouTube-"n-challenge" löst und
# nicht auf ~50 KB/s gedrosselt wird bzw. den "Sign in to confirm you're not a bot"-Fehler wirft.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages "yt-dlp[default]" \
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
