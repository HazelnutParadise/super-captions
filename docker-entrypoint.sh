#!/bin/sh
set -eu
cd /app

requirements_hash=$(sha256sum requirements-youtube.txt | cut -d ' ' -f 1)
marker=/opt/youtube/.requirements.sha256

if [ -f "$marker" ] && [ "$(cat "$marker")" = "$requirements_hash" ] \
  && /opt/youtube/bin/yt-dlp --version >/dev/null 2>&1 \
  && ffmpeg -version >/dev/null 2>&1; then
  echo '[startup] YouTube dependencies are already installed.'
else
  # Invalidate any old success marker before retrying a partial installation.
  if [ -f "$marker" ]; then rm "$marker"; fi
  echo '[startup] Installing Python and YouTube dependencies. The website will start when installation completes.'
  if ! apk add --no-cache python3 py3-pip; then
    echo '[startup] System dependency installation failed. The server was not started; restart the container to retry.' >&2
    exit 1
  fi
  if ! python3 -m venv /opt/youtube \
    || ! /opt/youtube/bin/pip install --no-cache-dir -r requirements-youtube.txt \
    || ! /opt/youtube/bin/pip check \
    || ! /opt/youtube/bin/yt-dlp --version \
    || ! ffmpeg -version >/dev/null; then
    echo '[startup] YouTube dependency installation failed. The server was not started; restart the container to retry.' >&2
    exit 1
  fi
  printf '%s\n' "$requirements_hash" > "$marker"
  echo '[startup] YouTube dependencies are ready.'
fi

if [ "${1:-}" = '--install-only' ]; then exit 0; fi
exec "$@"
