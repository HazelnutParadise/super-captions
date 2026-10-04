import { normalizeYouTubeUrl, YOUTUBE_MAX_BYTES, YOUTUBE_MAX_DURATION } from "./youtube-url";
import { matchesYouTubeDuration } from "./youtube-duration";
import type { YouTubeCaptionResult } from "./youtube-captions";

export async function requestYouTubeCaptions(url: string, signal: AbortSignal, trackId?: string): Promise<YouTubeCaptionResult> {
  const response = await fetch("/api/youtube/captions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: normalizeYouTubeUrl(url), ...(trackId ? { trackId } : {}) }),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : "取得 YouTube CC 失敗，請稍後再試"), { status: response.status });
  if (trackId ? typeof data?.srt !== "string" || data.track?.id !== trackId : !Array.isArray(data?.tracks)) {
    throw new Error("沒有取得可用的 CC 字幕，請稍後再試");
  }
  return data;
}

/** Probe the received File before any audio extraction or transcription. */
async function validateImportedVideo(file: File, expected: number, signal: AbortSignal | undefined,
  onDuration: (duration: number) => void): Promise<void> {
  signal?.throwIfAborted();
  const video = document.createElement("video");
  const blobUrl = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      let seeking = false;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        video.onloadedmetadata = video.ondurationchange = video.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new DOMException("匯入已取消", "AbortError"));
      const timer = setTimeout(() => finish(new Error("無法確認下載影片的長度，請重新匯入或改用本機影片")), 30_000);
      const check = () => {
        onDuration(video.duration);
        if (video.duration === Infinity) {
          // Some browsers discover fragmented MP4 duration only after seeking to its end.
          if (!seeking) {
            seeking = true;
            try { video.currentTime = 1e10; }
            catch { finish(new Error("無法確認下載影片的長度，請重新匯入")); }
          }
          return;
        }
        if (!matchesYouTubeDuration(video.duration, expected)) {
          finish(new Error("影片下載不完整，請重新匯入或改用本機影片"));
        } else finish();
      };
      video.onloadedmetadata = check;
      video.ondurationchange = check;
      video.onerror = () => finish(new Error("下載影片無法讀取，請重新匯入或改用本機影片"));
      signal?.addEventListener("abort", abort, { once: true });
      video.preload = "metadata";
      video.src = blobUrl;
      if (signal?.aborted) abort();
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(blobUrl);
  }
}

/** Receive and validate a live MP4 stream for the existing browser caption pipeline. */
export async function importYouTubeVideo(
  url: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<File> {
  const started = Date.now();
  let importId: string | null = null;
  let expectedDuration: number | null = null;
  let measuredDuration: number | null = null;
  let received = 0;
  let outcome = "request_failed";
  try {
    const response = await fetch("/api/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalizeYouTubeUrl(url) }),
      signal,
    });
    const responseId = response.headers.get("x-youtube-import-id");
    if (responseId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(responseId)) importId = responseId;
    outcome = "request_rejected";
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(typeof data?.error === "string" ? data.error : `匯入失敗（${response.status}），請稍後再試`);
    }
    if (!response.body || !response.headers.get("content-type")?.startsWith("video/mp4")) {
      await response.body?.cancel();
      throw new Error("沒有取得可用的影片，請稍後再試");
    }
    const total = Number(response.headers.get("content-length")) || 0;
    const expected = Number(response.headers.get("x-video-duration"));
    expectedDuration = Number.isFinite(expected) && expected > 0 && expected <= YOUTUBE_MAX_DURATION ? expected : null;
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    outcome = "invalid_headers";
    try {
      if (!Number.isFinite(expected) || expected <= 0 || expected > YOUTUBE_MAX_DURATION) {
        throw new Error("無法確認來源影片的長度，請重新匯入或改用本機影片");
      }
      if (total > YOUTUBE_MAX_BYTES) {
        outcome = "size_limit";
        throw new Error("影片超過 500 MB，請改用本機影片");
      }
      outcome = "stream_interrupted";
      while (true) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        received += value.byteLength;
        if (received > YOUTUBE_MAX_BYTES) {
          outcome = "size_limit";
          throw new Error("影片超過 500 MB，請改用本機影片");
        }
        chunks.push(value as Uint8Array<ArrayBuffer>);
        if (total > 0) onProgress?.(Math.min(99, received / total * 100));
      }
      if (!received || (total > 0 && received !== total)) throw new Error("影片下載不完整，請重新匯入");
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof TypeError) throw new Error("影片串流中斷，請重新匯入");
      throw error;
    } finally {
      reader.releaseLock();
    }
    let filename = "youtube-video.mp4";
    try { filename = decodeURIComponent(response.headers.get("x-video-filename") ?? filename); } catch {}
    const file = new File(chunks, filename, { type: "video/mp4" });
    outcome = "metadata_error";
    await validateImportedVideo(file, expected, signal, duration => {
      measuredDuration = Number.isFinite(duration) ? duration : null;
      if (Number.isFinite(duration) && !matchesYouTubeDuration(duration, expected)) outcome = "duration_mismatch";
    });
    signal?.throwIfAborted();
    onProgress?.(100);
    outcome = "complete";
    return file;
  } catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") outcome = "cancelled";
    throw error;
  } finally {
    console.info(JSON.stringify({ event: "youtube-import-client", importId, expectedDuration,
      measuredDuration, bytesReceived: received, outcome, elapsedMs: Date.now() - started }));
  }
}
