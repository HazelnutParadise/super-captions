"use client";

import { drawCaption, currentSegment } from "./caption-render";
import { getFFmpeg } from "./ffmpeg-client";
import {
  exportBurnedVideoWebCodecs,
  isWebCodecsExportSupported,
  probeWebCodecsConfig,
} from "./export-webcodecs";
import { makeDefaultSpeaker, type CaptionSegment, type SpeakerStyle } from "./types";

const FALLBACK_STYLE: SpeakerStyle = makeDefaultSpeaker("__fallback__", 0, "預設");

export type ExportFormat = "mp4" | "webm";
export type ExportPhase = "recording" | "transcoding";
export type ExportPipeline = "webcodecs" | "ffmpeg" | "webm";

export interface ExportOptions {
  /** Blob URL or file URL of the source video. */
  videoUrl: string;
  segments: CaptionSegment[];
  speakers: SpeakerStyle[];
  width: number;
  height: number;
  fps?: number;
  videoBitsPerSecond?: number;
  format?: ExportFormat;
  onProgress?: (phase: ExportPhase, ratio: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  ext: string;
  mimeType: string;
  /** Which code path actually produced this file. */
  pipeline: ExportPipeline;
}

/**
 * Tells the UI which pipeline a given format would use *right now* — useful
 * for showing a "GPU 加速" badge before the user clicks export.
 */
export async function probePipeline(
  format: ExportFormat,
  width: number,
  height: number,
  fps = 30
): Promise<ExportPipeline> {
  if (format === "webm") return "webm";
  if (isWebCodecsExportSupported()) {
    const ok = await probeWebCodecsConfig(width, height, fps);
    if (ok) return "webcodecs";
  }
  return "ffmpeg";
}

function pickRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(m)
    ) {
      return m;
    }
  }
  return "video/webm";
}

/**
 * Burn captions into the source video.
 *
 * Runs entirely on a fresh, hidden <video> element so the on-screen preview
 * is never touched — the user can keep scrubbing, editing captions, and
 * tweaking speaker styles while the export records in the background.
 *
 * Pipeline per call:
 *   1. mount an offscreen <video src={videoUrl}> and wait for metadata
 *   2. open a fresh AudioContext, wire MediaElementSource → MediaStreamDestination
 *      (no connection to ctx.destination so it does NOT play out loud)
 *   3. canvas.captureStream + the audio track → MediaRecorder → WebM
 *   4. (optional) transcode WebM → MP4 via ffmpeg.wasm
 *   5. tear down the element and close the AudioContext
 */
export async function exportBurnedVideo(
  opts: ExportOptions
): Promise<ExportResult> {
  const { videoUrl, segments, speakers, width, height } = opts;
  const fps = opts.fps ?? 30;
  const format: ExportFormat = opts.format ?? "mp4";

  // Fast path: MP4 via WebCodecs (HW AVC + AAC, no WebM intermediate).
  if (format === "mp4" && isWebCodecsExportSupported()) {
    const supported = await probeWebCodecsConfig(width, height, fps);
    if (supported) {
      try {
        const { blob } = await exportBurnedVideoWebCodecs({
          videoUrl,
          segments,
          speakers,
          width,
          height,
          fps,
          videoBitrate: opts.videoBitsPerSecond,
          onProgress: opts.onProgress,
          signal: opts.signal,
        });
        return {
          blob,
          ext: "mp4",
          mimeType: "video/mp4",
          pipeline: "webcodecs",
        };
      } catch (err) {
        // Fall through to MediaRecorder + ffmpeg path.
        console.warn(
          "[export] WebCodecs path failed, falling back to ffmpeg:",
          err
        );
      }
    }
  }

  const offscreen = document.createElement("video");
  offscreen.src = videoUrl;
  offscreen.preload = "auto";
  offscreen.playsInline = true;
  // We're going to route audio through WebAudio anyway, but mark it muted on
  // the element so the user never hears the export accidentally if the audio
  // routing fails.
  offscreen.muted = true;
  Object.assign(offscreen.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    top: "-9999px",
    left: "-9999px",
    pointerEvents: "none",
    opacity: "0",
  });
  document.body.appendChild(offscreen);

  // Wait for the element to know its duration / dimensions.
  await new Promise<void>((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Failed to load video for export"));
    };
    const cleanup = () => {
      offscreen.removeEventListener("loadedmetadata", ok);
      offscreen.removeEventListener("error", fail);
    };
    offscreen.addEventListener("loadedmetadata", ok);
    offscreen.addEventListener("error", fail);
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    offscreen.remove();
    throw new Error("Canvas 2D context unavailable");
  }

  const videoStream = canvas.captureStream(fps);

  let audioCtx: AudioContext | null = null;
  try {
    const AudioCtor: typeof AudioContext =
      window.AudioContext ??
      // @ts-expect-error - webkit prefix on older Safari
      window.webkitAudioContext;
    audioCtx = new AudioCtor();
    const src = audioCtx.createMediaElementSource(offscreen);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    // Deliberately NOT connecting to ctx.destination so the export is silent
    // to the user — preview audio is unaffected because that's a different
    // <video> element.
    if (audioCtx.state === "suspended") await audioCtx.resume();
    for (const track of dest.stream.getAudioTracks()) {
      videoStream.addTrack(track);
    }
  } catch {
    audioCtx = null;
  }

  const mimeType = pickRecorderMime();
  const recorder = new MediaRecorder(videoStream, {
    mimeType,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 6_000_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // Pin to start.
  offscreen.currentTime = 0;
  await new Promise<void>((resolve) => {
    const handler = () => {
      offscreen.removeEventListener("seeked", handler);
      resolve();
    };
    offscreen.addEventListener("seeked", handler);
  });

  drawFrame(ctx, offscreen, width, height, segments, speakers);

  const ended = new Promise<void>((resolve) => {
    const onEnded = () => {
      offscreen.removeEventListener("ended", onEnded);
      resolve();
    };
    offscreen.addEventListener("ended", onEnded);
  });

  recorder.start(500);
  await offscreen.play();

  let raf = 0;
  const duration = offscreen.duration;

  const tick = () => {
    if (opts.signal?.aborted) {
      cancelAnimationFrame(raf);
      recorder.stop();
      return;
    }
    drawFrame(ctx, offscreen, width, height, segments, speakers);
    opts.onProgress?.(
      "recording",
      duration > 0 ? Math.min(1, offscreen.currentTime / duration) : 0
    );
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  await ended;

  // Flush window — keep drawing for half a second so the recorder picks up
  // the audio tail and the final frames.
  await new Promise<void>((resolve) => {
    const stopAt = performance.now() + 500;
    const flush = () => {
      drawFrame(ctx, offscreen, width, height, segments, speakers);
      if (performance.now() >= stopAt) resolve();
      else requestAnimationFrame(flush);
    };
    flush();
  });

  cancelAnimationFrame(raf);
  recorder.stop();
  await stopped;

  // Teardown.
  try {
    offscreen.pause();
    offscreen.removeAttribute("src");
    offscreen.load();
  } catch {
    /* noop */
  }
  offscreen.remove();
  try {
    await audioCtx?.close();
  } catch {
    /* noop */
  }

  const webmBlob = new Blob(chunks, { type: mimeType });
  if (format === "webm") {
    return { blob: webmBlob, ext: "webm", mimeType, pipeline: "webm" };
  }

  const mp4Blob = await transcodeToMp4(webmBlob, (r) =>
    opts.onProgress?.("transcoding", r)
  );
  return {
    blob: mp4Blob,
    ext: "mp4",
    mimeType: "video/mp4",
    pipeline: "ffmpeg",
  };
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  segments: CaptionSegment[],
  speakers: SpeakerStyle[]
) {
  ctx.drawImage(video, 0, 0, width, height);
  const seg = currentSegment(segments, video.currentTime);
  if (seg && seg.text.trim()) {
    const sp =
      (seg.speakerId && speakers.find((p) => p.id === seg.speakerId)) ||
      speakers[0] ||
      FALLBACK_STYLE;
    drawCaption(ctx, width, height, seg.text, sp);
  }
}

async function transcodeToMp4(
  webm: Blob,
  onProgress?: (ratio: number) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const progressHandler = (e: { progress: number }) => {
    if (onProgress) onProgress(Math.max(0, Math.min(1, e.progress)));
  };
  ffmpeg.on("progress", progressHandler);

  const inputName = `burn-${Date.now()}.webm`;
  const outputName = `burn-${Date.now()}.mp4`;
  try {
    await ffmpeg.writeFile(
      inputName,
      new Uint8Array(await webm.arrayBuffer())
    );
    await ffmpeg.exec([
      "-i",
      inputName,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    const bytes = data as Uint8Array;
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return new Blob([ab], { type: "video/mp4" });
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch {
      /* noop */
    }
    ffmpeg.off("progress", progressHandler);
  }
}

export function segmentsToSRT(segments: CaptionSegment[]): string {
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  const fmt = (s: number) => {
    const ms = Math.round(s * 1000);
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const mmm = ms % 1000;
    return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
  };
  return segments
    .map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`)
    .join("\n");
}
