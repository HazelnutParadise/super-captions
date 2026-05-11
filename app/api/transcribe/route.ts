import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5148";

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
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
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

    console.log(
      `[transcribe] forwarding to ${GATEWAY}/v1/audio/transcriptions`
    );
    const upstream = await fetch(`${GATEWAY}/v1/audio/transcriptions`, {
      method: "POST",
      headers: upstreamHeaders,
      body: req.body,
      // Required by the fetch spec when body is a ReadableStream.
      // @ts-expect-error — duplex is not yet in the lib.dom typings.
      duplex: "half",
    });
    console.log(
      `[transcribe] upstream responded status=${upstream.status} after ${Date.now() - t0}ms`
    );

    const upstreamCT =
      upstream.headers.get("content-type") ?? "application/json";
    const text = await upstream.text();

    if (process.env.NODE_ENV !== "production") {
      const preview = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
      console.log(
        `[transcribe] gateway=${upstream.status} ct=${upstreamCT} bytes=${text.length} body=${preview}`
      );
    } else {
      console.log(
        `[transcribe] gateway=${upstream.status} ct=${upstreamCT} bytes=${text.length}`
      );
    }

    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": upstreamCT },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[transcribe] proxy failure:", message);
    return NextResponse.json(
      { error: "Transcription proxy failure", detail: message },
      { status: 502 }
    );
  }
}
