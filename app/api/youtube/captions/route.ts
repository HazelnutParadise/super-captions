import { getYouTubeCaptions } from "@/lib/youtube-captions";
import { YouTubeImportError } from "@/lib/youtube-download";
import { normalizeYouTubeUrl } from "@/lib/youtube-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let url: string;
  let trackId: string | undefined;
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
    if (body.trackId !== undefined) {
      if (typeof body.trackId !== "string" || !/^(manual|automatic):[A-Za-z0-9_-]{1,80}$/.test(body.trackId)) {
        throw new Error("請選擇有效的 CC 字幕");
      }
      trackId = body.trackId;
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error && !(error instanceof SyntaxError) ? error.message : "請提供 YouTube 影片網址" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await getYouTubeCaptions(url, request.signal, trackId);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof YouTubeImportError ? error.status : 500;
    const message = error instanceof YouTubeImportError ? error.message : "取得 YouTube CC 失敗，請稍後再試";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
