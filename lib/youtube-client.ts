import { normalizeYouTubeUrl, YOUTUBE_MAX_BYTES } from "./youtube-url";

/** Receive a live MP4 stream as a File for the existing browser caption pipeline. */
export async function importYouTubeVideo(
  url: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<File> {
  const response = await fetch("/api/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: normalizeYouTubeUrl(url) }),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(typeof data?.error === "string" ? data.error : `匯入失敗（${response.status}），請稍後再試`);
  }
  if (!response.body || !response.headers.get("content-type")?.startsWith("video/mp4")) {
    await response.body?.cancel();
    throw new Error("沒有取得可用的影片，請稍後再試");
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  try {
    if (total > YOUTUBE_MAX_BYTES) throw new Error("影片超過 500 MB，請改用本機影片");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > YOUTUBE_MAX_BYTES) throw new Error("影片超過 500 MB，請改用本機影片");
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
  onProgress?.(100);
  return new File(chunks, filename, { type: "video/mp4" });
}
