export const YOUTUBE_MAX_BYTES = 500 * 1024 * 1024;
export const YOUTUBE_MAX_DURATION = 60 * 60;

/** Accept a single YouTube video and discard all user-controlled extra parameters. */
export function normalizeYouTubeUrl(value: unknown): string {
  const invalid = () => new Error("請貼上有效的 YouTube 單支影片網址");
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw invalid();
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.match(/^\/([\w-]{11})\/?$/)?.[1] ?? null;
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) {
      id = url.searchParams.get("v");
    } else {
      id = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/)?.[1] ?? null;
    }
  } else if (["youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    id = url.pathname.match(/^\/embed\/([\w-]{11})\/?$/)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw invalid();
  return `https://www.youtube.com/watch?v=${id}`;
}
