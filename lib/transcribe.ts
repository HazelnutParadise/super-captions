import type { CaptionSegment } from "./types";
import { convertChinese, type ChineseScript } from "./chinese-convert";
import { resegment } from "./resegment";

/**
 * Response shape from 榛果繽紛樂's whisper-api when `advanced=true`.
 * See whisper_service/schemas.py in HazelnutParadise/whisper-api.
 */
interface AdvancedResponse {
  text?: string;
  language?: string;
  segments?: SegmentTimestamp[];
  diarization?: DiarizationSegment[];
  speakers?: string[];
}

interface SegmentTimestamp {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  speaker?: string | null;
  words?: WordTimestamp[];
}

interface WordTimestamp {
  word: string;
  start?: number;
  end?: number;
  speaker?: string | null;
}

interface DiarizationSegment {
  speaker: string;
  start: number;
  end: number;
}

interface SimpleResponse {
  text?: string;
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  /** When true, ask the backend to do speaker diarization. */
  diarize?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  /**
   * If set, every Chinese character in the returned segments is normalised
   * to the requested script via OpenCC before being shown to the user.
   * Whisper itself has no zh-TW vs zh-CN distinction, so this is the only
   * way to guarantee Traditional or Simplified output consistently.
   */
  convertTo?: ChineseScript;
}

export async function transcribeAudio(
  audioFile: File,
  options: TranscribeOptions = {}
): Promise<{
  segments: CaptionSegment[];
  raw: AdvancedResponse | SimpleResponse;
  speakerLabels: string[];
}> {
  const form = new FormData();
  form.append("file", audioFile);
  form.append("model", options.model ?? "whisper-1");
  form.append("advanced", "true");
  if (options.language) form.append("language", options.language);

  // `diarize` defaults to true on the backend. Send the explicit value so a
  // user toggle of "off" is respected.
  form.append("diarize", options.diarize === false ? "false" : "true");
  if (options.minSpeakers)
    form.append("min_speakers", String(options.minSpeakers));
  if (options.maxSpeakers)
    form.append("max_speakers", String(options.maxSpeakers));

  const r = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Transcription failed: ${r.status} ${text}`);
  }

  // The proxy responds with an NDJSON keepalive stream (see
  // app/api/transcribe/route.ts). We want the last line, which is the
  // `{"type":"result", ...}` envelope wrapping the actual gateway body.
  const streamText = await r.text();
  const lines = streamText.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? "";
  let envelope: { type: string; status: number; body: string };
  try {
    envelope = JSON.parse(lastLine);
  } catch {
    throw new Error(
      `Transcription failed: malformed proxy response (${streamText.slice(-200)})`
    );
  }
  if (envelope.type !== "result") {
    throw new Error(`Transcription failed: unexpected envelope type=${envelope.type}`);
  }
  if (envelope.status < 200 || envelope.status >= 300) {
    throw new Error(
      `Transcription failed: ${envelope.status} ${envelope.body.slice(0, 500)}`
    );
  }

  const bodyText = envelope.body;
  let data: AdvancedResponse | SimpleResponse;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { text: bodyText };
  }

  const advanced = data as AdvancedResponse;
  const speakerLabels: string[] = Array.isArray(advanced.speakers)
    ? advanced.speakers.slice()
    : [];

  let segments: CaptionSegment[] = [];

  if (Array.isArray(advanced.segments) && advanced.segments.length > 0) {
    segments = advanced.segments
      .map((s, i) => {
        const start = typeof s.start === "number" ? s.start : 0;
        const end =
          typeof s.end === "number" ? s.end : start + Math.max(0.5, 2);
        const speaker = s.speaker ?? null;
        if (speaker && !speakerLabels.includes(speaker))
          speakerLabels.push(speaker);
        return {
          id: `seg-${i}-${Math.round(start * 1000)}`,
          start,
          end: Math.max(end, start + 0.05),
          text: (s.text ?? "").trim(),
          speakerId: speaker,
        };
      })
      .filter((s) => s.text.length > 0);
  }

  // No segments came back — last-ditch: split flat text by sentence.
  if (segments.length === 0 && data.text && data.text.trim()) {
    segments = splitTextByDuration(data.text.trim(), null);
  }

  // OpenCC normalisation. Whisper doesn't distinguish zh-Hant from zh-Hans,
  // so when the user explicitly asked for one we run every segment through
  // OpenCC. Done in parallel; the dictionary is only fetched once.
  if (options.convertTo && segments.length > 0) {
    const target = options.convertTo;
    segments = await Promise.all(
      segments.map(async (s) => ({ ...s, text: await convertChinese(s.text, target) }))
    );
  }

  // Re-segment overly long captions. Whisper sometimes emits 60+ char single
  // segments for a fast monologue with no breath pauses; we slice them on
  // punctuation so each caption reads in one glance.
  segments = resegment(segments);

  return { segments, raw: data, speakerLabels };
}

function splitTextByDuration(
  text: string,
  duration: number | null
): CaptionSegment[] {
  const parts = text
    .split(/(?<=[。！？.!?…?！])\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
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
