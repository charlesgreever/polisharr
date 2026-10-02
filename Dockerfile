FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts vitest.config.ts ./
COPY src ./src
RUN npm test && npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg gosu tzdata mkvtoolnix libbluray2 python3 python3-venv tesseract-ocr tesseract-ocr-osd tesseract-ocr-eng \
  && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends jellyfin-ffmpeg8=8.1.3-1-bookworm \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && python3 -m venv /opt/whisper-lid \
  && /opt/whisper-lid/bin/pip install --no-cache-dir -U pip \
  && /opt/whisper-lid/bin/pip install --no-cache-dir faster-whisper \
  && python3 -m venv /opt/pgs-ocr \
  && /opt/pgs-ocr/bin/pip install --no-cache-dir -U pip \
  && /opt/pgs-ocr/bin/pip install --no-cache-dir pillow \
  && rm -rf /var/lib/apt/lists/* /root/.cache/pip

WORKDIR /app
ENV NODE_ENV=production \
    PORT=7373 \
    HOST=0.0.0.0 \
    CONFIG_DIR=/config \
    WEB_ROOT=/app/dist/web \
    FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    WHISPER_LID=/usr/local/bin/whisper-lid \
    PGS_OCR=/usr/local/bin/pgs-ocr \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PUID=1000 \
    PGID=1000 \
    TZ=America/New_York

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN mkdir -p /usr/local/lib/polisharr
COPY docker/whisper_lid.py /usr/local/lib/polisharr/whisper_lid.py
COPY docker/whisper-lid /usr/local/bin/whisper-lid
COPY docker/pgs_ocr.py /usr/local/lib/polisharr/pgs_ocr.py
COPY docker/pgs-ocr /usr/local/bin/pgs-ocr
RUN chmod +x /entrypoint.sh /usr/local/bin/whisper-lid /usr/local/bin/pgs-ocr \
  && /opt/whisper-lid/bin/python3 -m py_compile /usr/local/lib/polisharr/whisper_lid.py \
  && /opt/pgs-ocr/bin/python3 -m py_compile /usr/local/lib/polisharr/pgs_ocr.py

VOLUME ["/config"]
EXPOSE 7373
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
