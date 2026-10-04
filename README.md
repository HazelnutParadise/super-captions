# Super Captions

A privacy-preserving web app that auto-captions videos:

1. The user picks a video — a local file, or a single public YouTube link.
2. Audio is extracted **in the browser** with `ffmpeg.wasm`. Local video files never leave the device. For YouTube, the server streams the remote video and audio through FFmpeg directly to the browser without storing a temporary video.
3. The audio is sent to 榛果繽紛樂's OpenAI-compatible Whisper Gateway (e.g. `whisper-gateway:5000`).
4. The user previews the result side-by-side: video on the left, per-segment captions on the right, fully synchronised with the timeline.
5. Captions can be edited per-segment, with optional speaker diarisation and per-speaker styling (background, text border, text fill, font, size, etc.).
6. On export, captions are burned back into the video via Canvas + MediaRecorder, again entirely in-browser. An `.srt` file can be downloaded from the same bar.

Built with **Next.js 16 (App Router)**, **TypeScript**, **Tailwind**, **shadcn/ui**, **zustand**, and **ffmpeg.wasm**.

## Local development

```bash
npm install
npm run dev
```

If the workspace is on a network share that cannot sync Turbopack cache files, set `NEXT_TURBOPACK_FS_CACHE=0` in `.env.local`. This disables persistent compilation caching for both development and builds. Local disks keep the default cache behavior.

Set `WHISPER_GATEWAY_URL` to a reachable gateway — from the host the gateway is on port `5148`, see `.env.example`.

Tests run on Bun — `npm test` executes `bun test`. `npm run lint` runs ESLint, and `npm run typecheck` runs the TypeScript 7 compiler. The `typescript` package aliases the official TypeScript 6 compatibility package for Next.js and ESLint APIs; `@typescript/native` supplies the latest TypeScript 7 CLI. ESLint compatibility utilities adapt the current React plugins to ESLint 10. Tailwind 4 loads the existing theme through `@config`.

### yt-dlp for local YouTube imports

The YouTube import needs `yt-dlp[default]` (pinned in `requirements-youtube.txt`) and FFmpeg 9.0.2 on the server. On macOS, install FFmpeg first, then:

```bash
python3 -m venv .venv-youtube          # Python 3.10 or newer
.venv-youtube/bin/pip install -r requirements-youtube.txt
```

Without `YT_DLP_PATH` the server runs whatever `yt-dlp` is on `PATH`. To use the venv instead, put an absolute path in `.env.local`:

```
YT_DLP_PATH=/absolute/path/to/super-captions/.venv-youtube/bin/yt-dlp
```

`.venv-youtube/` is ignored by both Git and the Docker build context.

## YouTube import

`POST /api/youtube` imports one public YouTube video so it can flow through the same caption, edit, burn-in and `.srt` download steps as a local upload — `components/upload-card.tsx` adds a "YouTube 網址" tab for it.

Accepted links are `watch`, `youtu.be`, `/shorts/`, `/embed/` and `/live/` URLs. `lib/youtube-url.ts` reduces any of them to a bare video ID and discards every other parameter, so tracking parameters and playlists cannot ride along.

Limits, all enforced server-side:

- The video must have **ended** — live, upcoming and just-ended broadcasts are refused.
- Maximum **60 minutes**.
- Maximum **500 MiB** (checked against the metadata estimate and the actual streamed byte count).
- **Up to 720p H.264 video with AAC audio**, muxed to fragmented MP4 for the browser. Lower-resolution sources keep their original resolution.
- A **10-minute budget for the whole import**, shared between the metadata probe and the download.
- The metadata probe has a **60-second limit** before the video response begins.
- Media requests use bounded 1 MiB HTTP ranges to avoid unbounded-request throttling.
- Eligible media disconnects and HTTP `500`, `502`, `503`, `504` responses resume the same input with HTTP Range. Each input has at most two consecutive retries, with delays capped at two seconds and five seconds total. A whole-import budget stops FFmpeg on the fifth reconnect announcement, including retries after partial progress. The 10-minute deadline also covers recovery. `403`, `429`, ordinary EOF and non-seekable input are not retried.
- **One active import per server process**, response transfer included; further requests get `429`.

Not supported: private videos, members-only videos, age-restricted videos, anything requiring a sign-in, and playlists. `yt-dlp` runs with `--ignore-config --no-plugin-dirs` and is handed no cookies or credentials, so there is no path to authenticated content.

The server keeps only pipe buffers while downloading and muxing. Backpressure slows the downloader when the browser reads slowly. No video files are written to the server, so processed parts need no disk cleanup. Completion, cancellation, errors and timeout release the process and import slot. A successful FFmpeg exit must also include its final progress marker and a muxed duration and both video/audio presentation endpoints matching the source metadata. Packet timestamps are consumed in bounded pipe buffers; reordered frames use the greatest endpoint, and the final packet duration is included. The browser independently checks the received MP4 duration before audio extraction or transcription. Both checks allow a difference of `max(1, min(3, sourceSeconds * 0.001))` seconds for timestamp rounding and mux padding. Missing or invalid duration, unreadable media, and shorter or longer results outside that tolerance fail the import. The complete video stays in the browser for caption editing and export. Audio transcription still uses the existing gateway proxy and its temporary audio staging.

Each started import writes one JSON `youtube-import-server` record to server stdout: its random `importId`, expected source duration, FFmpeg version and exit code, final progress duration/marker, video/audio endpoints (`trackEndSeconds`), enqueued byte count, reconnect announcements, outcome and elapsed milliseconds. The response supplies `X-YouTube-Import-Id` for correlation, including failures before streaming. The browser console writes one `youtube-import-client` record with the same ID, expected/measured duration, received bytes, outcome and elapsed time. Missing measurements are `null`. Compare these records to distinguish a transport failure from browser duration rejection. Signed media URLs, video titles, credentials and raw FFmpeg stderr are excluded. The deployment image builds pinned FFmpeg 9.0.2 from its checksum-verified official release archive. The real-media tests check its [HTTP range/reconnect options](https://ffmpeg.org/ffmpeg-protocols.html#http) and stream-copy packet timestamps.

### YouTube CC and generated subtitles

After a YouTube import, the editor offers two separate downloads:

- **Generated subtitles** use the existing transcription pipeline. Edit them in the caption list, download `.srt`, or burn them into the video.
- **YouTube CC** preserves the text and timing supplied by YouTube. Pick a language and source in the CC panel, then download its `.srt`. Original CC and YouTube automatic captions are labeled separately. Automatically translated tracks are excluded.

CC downloads have a language and source suffix, such as `-youtube-cc-en.srt` or `-youtube-auto-en-orig.srt`. Downloading CC does not replace edits to generated subtitles. Local uploads keep their existing workflow.

`POST /api/youtube/captions` accepts `{ "url": "…YouTube URL…" }` to return `{ "tracks": [...] }`. Each track contains `id`, `language`, `name` and `source` (`manual` or `automatic`). Pass a returned ID as `trackId` to receive `{ "track": {...}, "srt": "..." }`. An empty list means no supported CC. If YouTube refuses CC, the panel shows a retry action and generated subtitles remain available.

The server reads metadata and at most **2 MiB** of subtitle text in memory. It stores no CC files or signed upstream URLs. CC requests have a **90-second overall timeout**, including a **60-second metadata timeout**, with **two concurrent requests per server process**. See `/api/openapi` for schemas and errors.

## Docker

Image is built on a pinned [`oven/bun:1.4.2-alpine`](https://hub.docker.com/r/oven/bun) — bump deliberately, never `:latest`. The container joins an existing `infra-net` network and resolves the gateway at `whisper-gateway:5000`:

```bash
docker compose up -d --build
```

The Dockerfile uses Bun for install, build, and runtime (`bun run server.js` on Next.js standalone output). The lockfile is `bun.lock`; `package-lock.json` is kept for local `npm` workflows.

As a temporary workaround for [Portainer's fixed 15-minute deployment deadline](https://github.com/portainer/portainer/issues/13314), the container installs `python3`, `py3-pip` and the pinned YouTube packages **at startup**, before starting the website. Portainer can finish creating the container while installation continues. The first start requires outbound access to Alpine and Python package repositories, and the website remains unavailable until installation completes. Follow progress with `docker compose logs -f super-captions`.

Completed installation is kept in the container's writable layer. Restarting the same container checks the requirements fingerprint and executables, then skips installation. Recreating the container installs again. An installation failure exits without starting the website or recording success; the existing `restart: unless-stopped` policy retries it.

`YT_DLP_PATH` points at `/opt/youtube/bin/yt-dlp`. `yt-dlp` reuses the Bun runtime already present in the image to solve YouTube's JavaScript challenges.

After Portainer supports a configurable deadline, restore build-time installation by changing `ARG YOUTUBE_DEPS_AT_BUILD=false` to `true` in the Dockerfile, or by passing `--build-arg YOUTUBE_DEPS_AT_BUILD=true` to `docker build`. The same installer runs during the build and the startup check skips it.

FFmpeg is compiled into the image at build time, with H.264/AAC MP4 and HTTPS support. Test the same binary against interrupted, shortened and complete inputs:

```bash
docker build --target youtube-test -t captions-youtube-test .
docker run --rm -v "$PWD:/source:ro" captions-youtube-test bun test tests/youtube-recovery.test.mjs
```

The startup regression checks run in a disposable container without downloading Python packages:

```bash
docker run --rm -v "$PWD:/source:ro" oven/bun:1.4.2-alpine sh /source/tests/docker-startup.sh
```

## Architecture notes

- `/api/transcribe` is a thin server-side proxy that forwards the multipart audio upload to `${WHISPER_GATEWAY_URL}/v1/audio/transcriptions`. It exists so the browser never needs to talk to the gateway directly (and so CORS doesn't bite).
- `lib/ffmpeg-client.ts` loads `@ffmpeg/core` from a CDN and converts the user's video to a 16 kHz mono MP3 entirely on the client. The Next config deliberately does **not** set COOP/COEP: the single-threaded `@ffmpeg/core` build runs fine without `SharedArrayBuffer`, and skipping those headers lets third-party scripts load without needing CORP headers from their origin.
- `lib/caption-render.ts` is the single source of truth for how a caption is drawn — both the live preview overlay and the export pipeline call into it, so what you see is what you get.
- `lib/export-video.ts` renders frames from the `<video>` element to an offscreen canvas at 30 fps, captures the canvas via `captureStream()`, and merges the original audio track. The result is a `video/webm` file you can download.
- `/api/youtube` takes `{ "url": "…YouTube URL…" }` and streams `video/mp4`, with an `X-Video-Filename` header holding the percent-encoded filename, `X-Video-Duration` holding the source duration in seconds, and `X-YouTube-Import-Id` correlating diagnostic records. The final muxed size is unknown, so there is no `Content-Length`. Clients must discard incomplete streams on error and validate the received media duration against `X-Video-Duration`, even when the response ends normally. HTTP 200 begins the stream and does not certify completion. `lib/youtube-client.ts` assembles the stream into the same browser `File` used for local upload, validates its duration, then starts audio extraction and transcription.
- `GET /api` lists the supported operations and `GET /api/openapi` returns the OpenAPI 3.0.3 document for all of them.
