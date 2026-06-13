import type { CaptionSegment } from "./types";
import { convertChinese, type ChineseScript } from "./chinese-convert";
import { resegment } from "./resegment";

/**
 * Response shape from 榛果繽紛樂's whisper-api when `advanced=true`.
 * See whisper_service/schemas.py in HazelnutParadise/whisper-api.
 */
export interface AdvancedResponse {
  text?: string;
  language?: string;
  segments?: SegmentTimestamp[];
  diarization?: DiarizationSegment[];
  speakers?: string[];
}

export interface SegmentTimestamp {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  speaker?: string | null;
  words?: WordTimestamp[];
}

export interface WordTimestamp {
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
  /**
   * When true, the backend runs LLM-based typo correction & resegmentation
   * (slower, more accurate). When false, only the basic mechanical
   * resegment() runs client-side — fast but rougher output.
   */
  useLLM?: boolean;
  /**
   * Fired whenever the proxy reports we're still in the gateway queue.
   * `ahead` is the number of jobs that will run before ours. When `ahead`
   * is 0 the gateway slot is ours and `onProcessing` will fire next.
   */
  onQueueStatus?: (status: { ahead: number }) => void;
  /** Fired exactly once when the proxy acquires the gateway slot. */
  onProcessing?: () => void;
  /**
   * Fired when LLM correction & re-segmentation runs on the backend. Called
   * once with no payload when the phase starts, then once per completed batch
   * with `{ done, total }` so the UI can render a determinate bar.
   */
  onLLMCorrecting?: (progress?: { done: number; total: number }) => void;
  /**
   * Fired when a transient transport failure trips an auto-retry. `attempt`
   * is the 1-indexed retry that's about to start; `maxAttempts` is the cap.
   */
  onRetry?: (info: { attempt: number; maxAttempts: number; reason: string }) => void;
}

/** Thrown when the NDJSON stream closes before a `result` line arrives AND
 *  the proxy hadn't yet acquired the gateway slot. Safe to retry because no
 *  work has reached the gateway. */
class StreamDroppedBeforeResultError extends Error {
  constructor(public readonly buffer: string) {
    super("與後端連線在排隊期間中斷");
    this.name = "StreamDroppedBeforeResultError";
  }
}

const MAX_ATTEMPTS = 3;

export async function transcribeAudio(
  audioFile: File,
  options: TranscribeOptions = {}
): Promise<{
  segments: CaptionSegment[];
  raw: AdvancedResponse | SimpleResponse;
  speakerLabels: string[];
}> {
  // Retry only the queue-before-processing window. Once the gateway has
  // started transcribing, a retry would double-bill the slot.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runTranscriptionAttempt(audioFile, options);
    } catch (e) {
      if (
        e instanceof StreamDroppedBeforeResultError &&
        attempt < MAX_ATTEMPTS
      ) {
        const backoffMs = 800 * Math.pow(2, attempt - 1); // 0.8s, 1.6s, 3.2s
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          reason: e.message,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      // Repack the final stream-drop error with a Chinese, user-facing
      // message that also mentions we already retried.
      if (e instanceof StreamDroppedBeforeResultError) {
        throw new Error(
          `與後端連線在排隊期間中斷，已自動重試 ${MAX_ATTEMPTS} 次仍失敗，請稍後再試。`
        );
      }
      throw e;
    }
  }
  // Unreachable in practice: the loop either returns or throws.
  throw new Error("轉錄失敗，已用盡所有重試。");
}

async function runTranscriptionAttempt(
  audioFile: File,
  options: TranscribeOptions
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

  // `use_llm` rides in the query string rather than the multipart form so
  // the route can read it without buffering & re-encoding the whole body —
  // the multipart stream is forwarded straight through to the gateway.
  const url = `/api/transcribe${options.useLLM ? "?use_llm=true" : ""}`;
  const r = await fetch(url, { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Transcription failed: ${r.status} ${text}`);
  }
  if (!r.body) {
    throw new Error("Transcription failed: empty response body");
  }

  // The proxy responds with an NDJSON keepalive stream (see
  // app/api/transcribe/route.ts). Lines we care about:
  //   {"type":"queued","ahead":N}     ← still waiting for a gateway slot
  //   {"type":"processing"}           ← slot acquired, gateway is running
  //   {"type":"ping",...}             ← keepalive while processing
  //   {"type":"result","status":N,"body":"..."}  ← final, always last
  // We read incrementally so the UI can show live queue position.
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let envelope: { type: "result"; status: number; body: string } | null = null;
  // Tracks whether we ever saw "processing"; if we did and the stream then
  // drops we MUST NOT retry (the gateway is mid-job and a retry would
  // duplicate the work).
  let processingSeen = false;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: {
        type?: string;
        ahead?: number;
        status?: number;
        body?: string;
        done?: number;
        total?: number;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      switch (msg.type) {
        case "queued":
          options.onQueueStatus?.({ ahead: msg.ahead ?? 0 });
          break;
        case "processing":
          processingSeen = true;
          options.onProcessing?.();
          break;
        case "correcting":
          options.onLLMCorrecting?.(
            typeof msg.total === "number" && msg.total > 0
              ? { done: msg.done ?? 0, total: msg.total }
              : undefined
          );
          break;
        case "result":
          envelope = {
            type: "result",
            status: msg.status ?? 0,
            body: msg.body ?? "",
          };
          break outer;
        // "ping" and unknown types: ignore.
      }
    }
    if (done) break;
  }

  if (!envelope) {
    if (!processingSeen) {
      // Retriable — the proxy never told us the gateway slot was ours, so
      // nothing has reached the ASR backend yet. Safe to redo the whole
      // upload from scratch.
      throw new StreamDroppedBeforeResultError(buffer);
    }
    throw new Error(
      "與後端的連線在轉錄途中斷掉了，請稍後再試一次。" +
        (buffer ? ` (tail=${buffer.slice(-200)})` : "")
    );
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
  if (!(data as any).llmProcessed) {
    segments = resegment(segments);
  }

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
