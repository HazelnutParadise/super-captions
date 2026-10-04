import { downloadYouTubeVideo, YouTubeImportError } from "@/lib/youtube-download";
import { normalizeYouTubeUrl } from "@/lib/youtube-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let url: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("請提供 YouTube 影片網址");
    let size = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new Error("網址資料過長"); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const body = JSON.parse(text);
    url = normalizeYouTubeUrl(body?.url);
  } catch (error) {
    return Response.json({ error: error instanceof Error && ! (error instanceof SyntaxError) ? error.message : "請提供 YouTube 影片網址" }, { status: 400 });
  }
  try {
    const video = await downloadYouTubeVideo(url, request.signal);
    return new Response(video.stream, { headers: {
      "Content-Type": "video/mp4",
      "X-Video-Filename": encodeURIComponent(video.filename),
      "X-Video-Duration": String(video.duration),
      "X-YouTube-Import-Id": video.importId,
      "Content-Disposition": `attachment; filename="youtube-video.mp4"; filename*=UTF-8''${encodeURIComponent(video.filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no",
    } });
  } catch (error) {
    const status = error instanceof YouTubeImportError ? error.status : 500;
    const message = error instanceof YouTubeImportError ? error.message : "匯入影片失敗，請稍後再試";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store",
      ...(error instanceof YouTubeImportError && error.importId ? { "X-YouTube-Import-Id": error.importId } : {}),
    } });
  }
}
