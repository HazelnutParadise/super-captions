import { spawn } from "node:child_process";
import { normalizeYouTubeUrl, YOUTUBE_MAX_BYTES, YOUTUBE_MAX_DURATION } from "./youtube-url";

export class YouTubeImportError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "YouTubeImportError";
  }
}

interface VideoStream {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  cleanup: () => Promise<void>;
}

let importing = false;
const FORMAT = "bv[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<=720]";
const TIMEOUT_MS = 10 * 60 * 1000;

function upstreamError(stderr: string): YouTubeImportError {
  if (/private video|video unavailable|not available|members.only|age.restricted|sign in to confirm your age/i.test(stderr)) {
    return new YouTubeImportError("這支影片無法公開下載，請選擇其他影片或改用本機影片", 422);
  }
  if (/confirm.*not a bot|HTTP Error 403|HTTP Error 429|403 Forbidden|429 Too Many/i.test(stderr)) {
    return new YouTubeImportError("YouTube 暫時拒絕下載，請稍後再試或改用本機影片", 502);
  }
  return new YouTubeImportError("影片串流中斷，請重新匯入或改用本機影片", 502);
}

/** Bounded subprocess pipes; no shell and no files on disk. */
function startProcess(command: string, args: string[], signal: AbortSignal, deadline: number, tool: string) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stderr = "";
  let failure: YouTubeImportError | null = null;
  let settled = false;
  let onFailure: ((error: YouTubeImportError) => void) | undefined;
  let resolveDone!: (error: YouTubeImportError | null) => void;
  const done = new Promise<YouTubeImportError | null>(resolve => { resolveDone = resolve; });
  const stop = (error: YouTubeImportError) => {
    if (!failure) failure = error;
    child.stdout.destroy(failure);
    onFailure?.(failure);
    if (!settled) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
    }
  };
  const abort = () => stop(new YouTubeImportError("匯入已取消", 499));
  child.stdout.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.on("error", (error: NodeJS.ErrnoException) => {
    failure = new YouTubeImportError(error.code === "ENOENT"
      ? "伺服器尚未安裝 " + tool + "，請聯絡管理者或改用本機影片"
      : "無法啟動影片匯入，請稍後再試", 503);
  });
  child.on("close", code => {
    settled = true;
    if (!failure && code !== 0) failure = upstreamError(stderr);
    resolveDone(failure);
    if (failure) onFailure?.(failure);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => stop(new YouTubeImportError("下載逾時，請稍後再試或改用本機影片", 504)), Math.max(0, deadline - Date.now()));
  return {
    output: child.stdout,
    done,
    stop,
    onFailure(callback: (error: YouTubeImportError) => void) {
      onFailure = callback;
      if (failure) callback(failure);
    },
    dispose() { clearTimeout(timer); signal.removeEventListener("abort", abort); },
  };
}

/** Read bounded metadata without downloading media or writing a cache. */
export async function readYouTubeMetadata(url: string, signal: AbortSignal, captionsOnly = false, deadline = Date.now() + 60_000) {
  const canonical = normalizeYouTubeUrl(url);
  if (signal.aborted) throw new YouTubeImportError("匯入已取消", 499);
  const probe = startProcess(process.env.YT_DLP_PATH || "yt-dlp", [
    "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist", "--no-warnings",
    "--js-runtimes", (process.versions.bun ? "bun" : "node") + ":" + process.execPath,
    "--socket-timeout", "20", "--retries", "1", "--skip-download", "--dump-single-json",
    ...(captionsOnly ? ["--ignore-no-formats-error", "--extractor-args", "youtube:skip=hls,dash,translated_subs"] : ["--format", FORMAT]), "--", canonical,
  ], signal, Math.min(deadline, Date.now() + 60_000), "yt-dlp");
  let text = "";
  try {
    for await (const chunk of probe.output) {
      text += chunk.toString();
      if (text.length > 4 * 1024 * 1024) probe.stop(new YouTubeImportError("無法讀取影片資訊", 502));
    }
    const error = await probe.done;
    if (error) throw error;
  } catch (error) {
    const processError = await probe.done;
    throw processError ?? error;
  } finally { probe.dispose(); }
  let info;
  try { info = JSON.parse(text); } catch { throw new YouTubeImportError("無法讀取影片資訊", 502); }
  if (!info || info._type === "playlist" || info.is_live || ["is_live", "is_upcoming", "post_live"].includes(info.live_status)) {
    throw new YouTubeImportError("目前只支援已結束的單支影片，請勿貼上直播或播放清單", 422);
  }
  if (typeof info.duration !== "number" || !Number.isFinite(info.duration) || info.duration <= 0) {
    throw new YouTubeImportError("無法確認影片長度，請改用本機影片", 422);
  }
  if (info.duration > YOUTUBE_MAX_DURATION) throw new YouTubeImportError("影片超過 60 分鐘，請改用本機影片", 422);
  return info;
}

/** Resolve public streams, then mux directly to the browser. Never creates a temporary video. */
export async function downloadYouTubeVideo(url: string, signal: AbortSignal): Promise<VideoStream> {
  const canonical = normalizeYouTubeUrl(url);
  if (signal.aborted) throw new YouTubeImportError("匯入已取消", 499);
  if (importing) throw new YouTubeImportError("目前有影片正在匯入，請稍後再試", 429);
  importing = true;
  const deadline = Date.now() + TIMEOUT_MS;
  let converter: ReturnType<typeof startProcess> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      if (converter) {
        converter.stop(new YouTubeImportError("匯入已取消", 499));
        await converter.done;
        converter.dispose();
      }
    } finally { importing = false; }
  })();
  try {
    const info = await readYouTubeMetadata(canonical, signal, false, deadline);
    const formats = info.requested_formats ?? [info];
    if (!Array.isArray(formats) || formats.length < 1 || formats.length > 2) throw new YouTubeImportError("無法取得可用的影音格式", 502);
    const estimated = formats.reduce((sum: number, f: { filesize?: number; filesize_approx?: number }) => sum + (f.filesize ?? f.filesize_approx ?? 0), 0);
    if (estimated > YOUTUBE_MAX_BYTES) throw new YouTubeImportError("影片超過 500 MB，請改用本機影片", 413);
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
    for (const format of formats) {
      const media = new URL(format.url);
      if (media.protocol !== "https:" || !media.hostname.endsWith(".googlevideo.com") || media.username || media.password || media.port) {
        throw new YouTubeImportError("YouTube 回傳了無法使用的影音來源", 502);
      }
      args.push("-protocol_whitelist", "https,tls,tcp,http,crypto", "-rw_timeout", "20000000", "-i", media.href);
    }
    args.push("-map", "0:v:0", "-map", formats.length === 2 ? "1:a:0" : "0:a:0",
      "-c", "copy", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
    converter = startProcess(process.env.FFMPEG_PATH || "ffmpeg", args, signal, deadline, "FFmpeg");
    const running = converter;
    const iterator = running.output[Symbol.asyncIterator]();
    let first: IteratorResult<Buffer> | undefined;
    try { first = await iterator.next(); }
    catch (error) { throw (await running.done) ?? error; }
    if (first.done) {
      const error = await running.done;
      throw error ?? new YouTubeImportError("沒有取得可用的影片，請改用本機影片", 502);
    }
    let bytes = 0;
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      async pull(c) {
        if (finished) return;
        try {
          const part = first ?? await iterator.next();
          first = undefined;
          if (finished) return;
          if (part.done) {
            const error = await running.done;
            if (error) throw error;
            finished = true;
            await cleanup();
            c.close();
          } else {
            bytes += part.value.byteLength;
            if (bytes > YOUTUBE_MAX_BYTES) throw new YouTubeImportError("影片超過 500 MB，請改用本機影片", 413);
            c.enqueue(new Uint8Array(part.value));
          }
        } catch (error) {
          if (!finished) { finished = true; c.error(error); }
          await cleanup();
        }
      },
      async cancel() { finished = true; await cleanup(); },
    }, { highWaterMark: 0 });
    running.onFailure(error => {
      if (finished) return;
      finished = true;
      controller.error(error);
      void cleanup();
    });
    const title = (typeof info.title === "string" ? info.title : "youtube-video")
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim().slice(0, 120) || "youtube-video";
    return { stream, filename: title + ".mp4", cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
