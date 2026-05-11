# Super Captions

A privacy-preserving web app that auto-captions videos:

1. The user picks a video locally.
2. Audio is extracted **in the browser** with `ffmpeg.wasm` — the video itself never leaves the device.
3. The audio is sent to 榛果繽紛樂's OpenAI-compatible Whisper Gateway (e.g. `whisper-gateway:5148`).
4. The user previews the result side-by-side: video on the left, per-segment captions on the right, fully synchronised with the timeline.
5. Captions can be edited per-segment, with optional speaker diarisation and per-speaker styling (background, text border, text fill, font, size, etc.).
6. On export, captions are burned back into the video via Canvas + MediaRecorder, again entirely in-browser.

Built with **Next.js 15 (App Router)**, **TypeScript**, **Tailwind**, **shadcn/ui**, **zustand**, and **ffmpeg.wasm**.

## Local development

```bash
npm install
npm run dev
```

Set `WHISPER_GATEWAY_URL` if your gateway isn't on `whisper-gateway:5148`.

## Docker

Image is built on a pinned [`oven/bun:1.3.13-alpine`](https://hub.docker.com/r/oven/bun) — bump deliberately, never `:latest`. The container joins an existing `infra-net` network and resolves the gateway at `whisper-gateway:5148`:

```bash
docker compose up -d --build
```

The Dockerfile uses Bun for install, build, and runtime (`bun run server.js` on Next.js standalone output). The lockfile is `bun.lock`; `package-lock.json` is kept for local `npm` workflows.

## Architecture notes

- `/api/transcribe` is a thin server-side proxy that forwards the multipart audio upload to `${WHISPER_GATEWAY_URL}/v1/audio/transcriptions`. It exists so the browser never needs to talk to the gateway directly (and so CORS doesn't bite).
- `lib/ffmpeg-client.ts` loads `@ffmpeg/core` from a CDN and converts the user's video to a 16 kHz mono MP3 entirely on the client. The Next config sets the COOP/COEP headers required for `SharedArrayBuffer`.
- `lib/caption-render.ts` is the single source of truth for how a caption is drawn — both the live preview overlay and the export pipeline call into it, so what you see is what you get.
- `lib/export-video.ts` renders frames from the `<video>` element to an offscreen canvas at 30 fps, captures the canvas via `captureStream()`, and merges the original audio track. The result is a `video/webm` file you can download.
