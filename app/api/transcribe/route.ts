import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5148";

/**
 * Proxies multipart/form-data audio transcription to the 榛果繽紛樂 Speech
 * Gateway. The gateway only honors a fixed set of form fields:
 *
 *   file          required — audio bytes
 *   model         "whisper-1" | "turbo"
 *   language      ISO code, omit for auto-detect
 *   advanced      "true" → return segments[], words[], language, speakers[]
 *                 "false" (default) → return only {text}
 *   diarize       defaults to true on the backend
 *   min_speakers  optional hint
 *   max_speakers  optional hint
 *
 * Anything else is silently dropped by the upstream service, so we filter
 * the incoming form to only these names before forwarding.
 */
const FORWARDED_FIELDS = new Set([
  "file",
  "model",
  "language",
  "advanced",
  "diarize",
  "min_speakers",
  "max_speakers",
]);

export async function POST(req: NextRequest) {
  try {
    const incoming = await req.formData();

    const file = incoming.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Missing audio 'file' field" },
        { status: 400 }
      );
    }

    const outgoing = new FormData();
    outgoing.append("file", file, (file as File).name || "audio.webm");

    const seen = new Set<string>();
    for (const [key, value] of incoming.entries()) {
      if (key === "file") continue;
      if (!FORWARDED_FIELDS.has(key)) continue;
      outgoing.append(key, value as string);
      seen.add(key);
    }
    // Always request the rich response.
    if (!seen.has("advanced")) outgoing.append("advanced", "true");
    if (!seen.has("model")) outgoing.append("model", "whisper-1");

    const upstream = await fetch(`${GATEWAY}/v1/audio/transcriptions`, {
      method: "POST",
      body: outgoing,
    });

    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    const text = await upstream.text();

    // Dev-only breadcrumb so we can see what the gateway returned during
    // local iteration. NEVER logs in production — keeps user transcripts
    // off the server.
    if (process.env.NODE_ENV !== "production") {
      const preview = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
      console.log(
        `[transcribe] gateway=${upstream.status} ct=${contentType} bytes=${text.length} body=${preview}`
      );
    } else {
      console.log(
        `[transcribe] gateway=${upstream.status} ct=${contentType} bytes=${text.length}`
      );
    }

    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": contentType },
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
