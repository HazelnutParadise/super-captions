"use client";

import { drawCaption, currentSegment } from "./caption-render";
import { makeDefaultSpeaker, type CaptionSegment, type SpeakerStyle } from "./types";

const DEFAULT_STYLE: SpeakerStyle = makeDefaultSpeaker("__default__", 0, "預設");

export interface ExportOptions {
  video: HTMLVideoElement;
  segments: CaptionSegment[];
  speakers: SpeakerStyle[];
  width: number;
  height: number;
  fps?: number;
  videoBitsPerSecond?: number;
  onProgress?: (ratio: number, currentTime: number, duration: number) => void;
  signal?: AbortSignal;
}

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "video/webm";
}

/**
 * Burn captions into the source video by drawing each frame to an offscreen
 * canvas (with the caption overlay) and capturing a MediaStream from it.
 *
 * Audio is preserved by ferrying it through a WebAudio graph -- the source
 * video's audio is captured via captureStream() and merged in.
 */
export async function exportBurnedVideo(opts: ExportOptions): Promise<Blob> {
  const { video, segments, speakers, width, height } = opts;
  const fps = opts.fps ?? 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const videoStream = canvas.captureStream(fps);

  // Add an audio track from the underlying video element via WebAudio.
  let audioContext: AudioContext | null = null;
  try {
    audioContext = new (window.AudioContext ||
      // @ts-expect-error - webkit prefix
      window.webkitAudioContext)();
    const source = audioContext.createMediaElementSource(video);
    const dest = audioContext.createMediaStreamDestination();
    source.connect(dest);
    // Still play through speakers so user hears it during export.
    source.connect(audioContext.destination);
    for (const track of dest.stream.getAudioTracks()) {
      videoStream.addTrack(track);
    }
  } catch {
    // MediaElementSource can only be created once per element. If we've
    // already wired it in a previous export, just continue without audio.
  }

  const mimeType = pickMimeType();
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

  // Pin to start, render frames in real time as the video plays.
  video.pause();
  video.currentTime = 0;
  await new Promise<void>((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
  });

  recorder.start(250);
  await video.play();

  let raf = 0;
  const duration = video.duration;

  const tick = () => {
    if (opts.signal?.aborted) {
      cancelAnimationFrame(raf);
      recorder.stop();
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);

    const seg = currentSegment(segments, video.currentTime);
    if (seg && seg.text.trim()) {
      const sp =
        (seg.speakerId && speakers.find((p) => p.id === seg.speakerId)) ||
        DEFAULT_STYLE;
      drawCaption(ctx, width, height, seg.text, sp);
    }

    opts.onProgress?.(
      duration > 0 ? Math.min(1, video.currentTime / duration) : 0,
      video.currentTime,
      duration
    );

    if (video.ended || video.paused) {
      cancelAnimationFrame(raf);
      recorder.stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  await stopped;
  try {
    audioContext?.close();
  } catch {
    /* noop */
  }

  return new Blob(chunks, { type: mimeType });
}

/** Build an SRT string from the current segments. */
export function segmentsToSRT(segments: CaptionSegment[]): string {
  const fmt = (s: number) => {
    const ms = Math.round(s * 1000);
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const mmm = ms % 1000;
    return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
  };
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return segments
    .map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`)
    .join("\n");
}
