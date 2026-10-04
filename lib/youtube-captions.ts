import { readYouTubeMetadata, YouTubeImportError } from "./youtube-download";

export interface YouTubeCaptionTrack {
  id: string;
  language: string;
  name: string;
  source: "manual" | "automatic";
}

export type YouTubeCaptionResult = { tracks: YouTubeCaptionTrack[] } | { track: YouTubeCaptionTrack; srt: string };

const MAX_REQUESTS = 2;
const BUDGET_MS = 90_000;
const CAPTION_MAX_BYTES = 2 * 1024 * 1024;
const LANGUAGE = /^[A-Za-z0-9_-]{1,80}$/;
const SRT_TIMING = /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/;
const RETRY_MESSAGE = "YouTube 暫時無法提供 CC 字幕，請稍後再試";

let active = 0;

interface CaptionFormat { ext?: unknown; url?: unknown; name?: unknown }

/** Only HTTPS youtube.com timedtext URLs without credentials, ports or translation. */
function timedTextUrl(format: CaptionFormat): URL | null {
  if (format?.ext !== "srt" || typeof format.url !== "string") return null;
  let url: URL;
  try { url = new URL(format.url); } catch { return null; }
  if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com"].includes(url.hostname)) return null;
  if (url.port || url.username || url.password || url.pathname !== "/api/timedtext") return null;
  if (url.searchParams.has("tlang")) return null;
  return url;
}

/** Collects usable tracks, keeping signed URLs server-side. */
function collectTracks(info: Record<string, unknown>) {
  const found = new Map<string, { track: YouTubeCaptionTrack; url: URL; orig: boolean }>();
  for (const source of ["manual", "automatic"] as const) {
    const groups = info[source === "manual" ? "subtitles" : "automatic_captions"];
    if (!groups || typeof groups !== "object") continue;
    for (const [key, formats] of Object.entries(groups as Record<string, CaptionFormat[]>)) {
      if (!Array.isArray(formats)) continue;
      const language = source === "automatic" ? key.replace(/-orig$/, "") : key;
      if (!LANGUAGE.test(language)) continue;
      const id = `${source}:${language}`;
      for (const format of formats) {
        const url = timedTextUrl(format);
        if (!url) continue;
        const orig = source === "automatic" && (key.endsWith("-orig") || /-orig$/.test(url.searchParams.get("lang") ?? ""));
        const existing = found.get(id);
        if (existing && (existing.orig || !orig)) continue;
        const name = typeof format.name === "string" && format.name.trim() ? format.name : language;
        const nativeLanguage = orig ? `${language}-orig` : language;
        if (!LANGUAGE.test(nativeLanguage)) continue;
        found.set(id, { track: { id: `${source}:${nativeLanguage}`, language: nativeLanguage, name, source }, url, orig });
      }
    }
  }
  return found;
}

async function readCaption(response: Response): Promise<string> {
  const lengthHeader = response.headers.get("Content-Length");
  const declared = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(declared) && declared > CAPTION_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeImportError("CC 字幕檔案過大，無法匯入", 413);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CAPTION_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw new YouTubeImportError("CC 字幕檔案過大，無法匯入", 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  // Fetch decodes compressed bodies, so their wire length cannot be compared here.
  if (Number.isFinite(declared) && !response.headers.has("Content-Encoding") && declared !== size) {
    throw new YouTubeImportError(RETRY_MESSAGE, 502);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** Lists native CC tracks, or retrieves one bounded SRT. Errors use YouTubeImportError. */
export async function getYouTubeCaptions(url: string, signal: AbortSignal, trackId?: string): Promise<YouTubeCaptionResult> {
  if (signal.aborted) throw new YouTubeImportError("已取消", 499);
  if (active >= MAX_REQUESTS) throw new YouTubeImportError("目前 CC 字幕請求過多，請稍後再試", 429);
  active++;
  const deadline = Date.now() + BUDGET_MS;
  const controller = new AbortController();
  let reason: YouTubeImportError | null = null;
  const stop = (error: YouTubeImportError) => {
    if (reason) return;
    reason = error;
    controller.abort(error);
  };
  const onAbort = () => stop(new YouTubeImportError("已取消", 499));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(new YouTubeImportError("讀取 CC 字幕逾時，請稍後再試", 504)), BUDGET_MS);
  try {
    const info = await readYouTubeMetadata(url, controller.signal, true, deadline);
    const tracks = collectTracks(info);
    if (!trackId) return { tracks: [...tracks.values()].map(entry => entry.track) };
    const entry = [...tracks.values()].find(candidate => candidate.track.id === trackId);
    if (!entry) throw new YouTubeImportError("找不到這個 CC 字幕", 404);
    let srt: string;
    try {
      const response = await fetch(entry.url, { redirect: "error", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new YouTubeImportError(RETRY_MESSAGE, 502);
      }
      srt = await readCaption(response);
    } catch (error) {
      if (reason) throw reason;
      if (error instanceof YouTubeImportError) throw error;
      throw new YouTubeImportError(RETRY_MESSAGE, 502);
    }
    if (!srt.trim() || srt.trimStart().startsWith("<") || !SRT_TIMING.test(srt)) {
      throw new YouTubeImportError(RETRY_MESSAGE, 502);
    }
    return { track: entry.track, srt };
  } catch (error) {
    if (reason) throw reason;
    if (error instanceof YouTubeImportError && error.status === 502) throw new YouTubeImportError(RETRY_MESSAGE, 502);
    if (error instanceof YouTubeImportError && error.status === 504) throw new YouTubeImportError("讀取 CC 字幕逾時，請稍後再試", 504);
    if (error instanceof YouTubeImportError && error.status === 422) throw new YouTubeImportError("這支影片目前無法提供 CC，請選擇其他影片", 422);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    active--;
  }
}
