import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5148";

/**
 * Proxies multipart/form-data audio transcription to the OpenAI-compatible
 * Speech Gateway provided by 榛果繽紛樂. The browser POSTs an audio file
 * extracted from the user's video and gets back a verbose-JSON transcript
 * with timestamped segments.
 */
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

    const model = (incoming.get("model") as string | null) ?? "whisper-1";
    const language = incoming.get("language") as string | null;
    const responseFormat =
      (incoming.get("response_format") as string | null) ?? "verbose_json";
    const prompt = incoming.get("prompt") as string | null;
    const temperature = incoming.get("temperature") as string | null;
    const granularities =
      (incoming.getAll("timestamp_granularities[]") as string[]) ?? [];

    const outgoing = new FormData();
    outgoing.append("file", file, (file as File).name || "audio.webm");
    outgoing.append("model", model);
    outgoing.append("response_format", responseFormat);
    if (language) outgoing.append("language", language);
    if (prompt) outgoing.append("prompt", prompt);
    if (temperature) outgoing.append("temperature", temperature);
    for (const g of granularities.length
      ? granularities
      : ["segment", "word"]) {
      outgoing.append("timestamp_granularities[]", g);
    }

    const upstream = await fetch(`${GATEWAY}/v1/audio/transcriptions`, {
      method: "POST",
      body: outgoing,
    });

    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    const text = await upstream.text();

    // Server-side breadcrumb so we can see exactly what the gateway returned.
    const preview = text.length > 1200 ? text.slice(0, 1200) + "…" : text;
    console.log(
      `[transcribe] gateway=${upstream.status} ct=${contentType} bytes=${text.length} body=${preview}`
    );

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
