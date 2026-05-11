import type { CaptionSegment } from "./types";

interface AnySegment {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  // Some ASR backends use `timestamp: [start, end]` instead of start/end.
  timestamp?: [number | null, number | null];
}

interface AnyResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: AnySegment[];
  chunks?: AnySegment[];
  // OpenAI verbose_json variant with words.
  words?: { word: string; start: number; end: number }[];
}

export async function transcribeAudio(
  audioFile: File,
  options: { model?: string; language?: string } = {}
): Promise<{
  segments: CaptionSegment[];
  raw: AnyResponse;
}> {
  const form = new FormData();
  form.append("file", audioFile);
  form.append("model", options.model ?? "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  if (options.language) form.append("language", options.language);

  const r = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Transcription failed: ${r.status} ${text}`);
  }

  // The gateway might return text/plain SRT/VTT, or JSON — be tolerant.
  const ct = r.headers.get("content-type") ?? "";
  const bodyText = await r.text();
  let data: AnyResponse | null = null;
  if (ct.includes("application/json")) {
    try {
      data = JSON.parse(bodyText) as AnyResponse;
    } catch {
      /* fall through */
    }
  } else {
    // Maybe still JSON despite a different content-type.
    try {
      data = JSON.parse(bodyText) as AnyResponse;
    } catch {
      data = { text: bodyText };
    }
  }
  if (!data) data = { text: bodyText };

  // Normalise to OpenAI-style segments.
  const raw: AnySegment[] = data.segments ?? data.chunks ?? [];
  let segments: CaptionSegment[] = raw
    .map((s, i) => {
      const start =
        typeof s.start === "number"
          ? s.start
          : Array.isArray(s.timestamp)
          ? s.timestamp[0] ?? 0
          : 0;
      const end =
        typeof s.end === "number"
          ? s.end
          : Array.isArray(s.timestamp)
          ? s.timestamp[1] ?? start + 2
          : start + 2;
      return {
        id: `seg-${i}-${Math.round(start * 1000)}`,
        start,
        end: Math.max(end, start + 0.05),
        text: (s.text ?? "").trim(),
        speakerId: null as string | null,
      };
    })
    .filter((s) => s.text.length > 0);

  // Fallback 1: gateway returned word-level only — group every ~7 words.
  if (segments.length === 0 && data.words && data.words.length) {
    segments = chunkWords(data.words, 7);
  }

  // Fallback 2: gateway returned only flat text — split by sentence and
  // spread evenly across the known duration so the timeline still works.
  if (segments.length === 0 && data.text && data.text.trim()) {
    segments = splitTextByDuration(data.text.trim(), data.duration ?? null);
  }

  return { segments, raw: data };
}

function chunkWords(
  words: { word: string; start: number; end: number }[],
  groupSize: number
): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (let i = 0; i < words.length; i += groupSize) {
    const chunk = words.slice(i, i + groupSize);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    out.push({
      id: `seg-w-${i}`,
      start,
      end: Math.max(end, start + 0.05),
      text: chunk
        .map((w) => w.word)
        .join("")
        .trim(),
      speakerId: null,
    });
  }
  return out;
}

function splitTextByDuration(
  text: string,
  duration: number | null
): CaptionSegment[] {
  // Split by sentence boundaries (works for zh/en/ja/ko punctuation).
  const parts = text
    .split(/(?<=[。！？.!?…?！])\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];

  // If we don't know the duration, give each line a 3s slot.
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const total = duration && duration > 0 ? duration : parts.length * 3;

  const out: CaptionSegment[] = [];
  let t = 0;
  for (let i = 0; i < parts.length; i++) {
    const fraction = parts[i].length / Math.max(1, totalLen);
    const len = Math.max(0.6, total * fraction);
    const start = t;
    const end = Math.min(total, start + len);
    out.push({
      id: `seg-t-${i}`,
      start,
      end,
      text: parts[i],
      speakerId: null,
    });
    t = end;
  }
  return out;
}
