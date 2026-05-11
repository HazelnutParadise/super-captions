import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5000";

/**
 * Streaming proxy from the browser to 榛果繽紛樂's Speech Gateway. The
 * gateway expects a multipart/form-data body with these fields (anything
 * else is silently dropped upstream, so the client is responsible for
 * only sending what it should):
 *
 *   file          required — audio bytes
 *   model         "whisper-1" | "turbo"
 *   language      ISO code, omit for auto-detect
 *   advanced      "true" → segments[]/words[]/speakers[]
 *   diarize       defaults to true on the backend
 *   min_speakers  optional hint
 *   max_speakers  optional hint
 *
 * We intentionally do NOT call req.formData() — that buffers the entire
 * upload (potentially hundreds of MB for multi-hour videos) into memory,
 * which can OOM the container. Instead we pipe req.body straight to the
 * upstream fetch, with the original multipart boundary preserved.
 */
/**
 * Whisper transcription on multi-hour audio can take several minutes.
 * Cloudflare's Free/Pro tiers cut idle connections at 100 s with a 524, so
 * we cannot simply return the upstream response synchronously.
 *
 * Workaround: respond immediately with a 200 + an NDJSON stream.
 *   - Every 20 s we emit `{"type":"ping",...}\n` as a keepalive.
 *   - When the gateway finally replies we emit a final
 *     `{"type":"result","status":<n>,"body":"<gateway body>"}\n` line.
 * From CF's POV bytes keep flowing, so the request never goes idle.
 * The client reads the whole body, locates the last NDJSON line and
 * unwraps the envelope.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const contentType = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length");
  console.log(
    `[transcribe] POST received ct=${contentType} cl=${contentLength ?? "n/a"} hasBody=${!!req.body}`
  );

  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const upstreamHeaders: Record<string, string> = { "content-type": contentType };
  if (contentLength) upstreamHeaders["content-length"] = contentLength;

  console.log(`[transcribe] forwarding to ${GATEWAY}/v1/audio/transcriptions`);

  // Kick the upstream fetch off *now* (not inside the stream's start callback)
  // so that req.body begins draining into upstream immediately. The promise
  // resolves once the gateway returns its response headers.
  const upstreamPromise: Promise<
    | { ok: true; status: number; body: string }
    | { ok: false; status: number; body: string }
  > = fetch(`${GATEWAY}/v1/audio/transcriptions`, {
    method: "POST",
    headers: upstreamHeaders,
    body: req.body,
    // @ts-expect-error — duplex is not yet in the lib.dom typings.
    duplex: "half",
  })
    .then(async (r) => {
      const body = await r.text();
      console.log(
        `[transcribe] upstream status=${r.status} bytes=${body.length} after ${Date.now() - t0}ms`
      );
      return { ok: r.ok, status: r.status, body };
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[transcribe] upstream error:", msg);
      return { ok: false, status: 502, body: JSON.stringify({ error: msg }) };
    });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "ping", t: Date.now() - t0 }) + "\n"
            )
          );
        } catch {
          /* controller may already be closed */
        }
      }, 20_000);

      upstreamPromise.then((envelope) => {
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "result", ...envelope }) + "\n"
            )
          );
        } catch {
          /* ignore */
        }
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
