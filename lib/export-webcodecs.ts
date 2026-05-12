"use client";

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { drawCaption, currentSegment } from "./caption-render";
import {
  makeDefaultSpeaker,
  type CaptionSegment,
  type SpeakerStyle,
} from "./types";
import type { ExportPhase } from "./export-video";

const FALLBACK_STYLE: SpeakerStyle = makeDefaultSpeaker("__fallback__", 0, "預設");

export interface WebCodecsExportOptions {
  videoUrl: string;
  segments: CaptionSegment[];
  speakers: SpeakerStyle[];
  width: number;
  height: number;
  fps?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  onProgress?: (phase: ExportPhase, ratio: number) => void;
  signal?: AbortSignal;
}

export interface WebCodecsExportResult {
  blob: Blob;
}

export type WebCodecsUnavailableReason =
  | "ssr"
  | "insecure-context"
  | "missing-video-encoder"
  | "missing-audio-encoder"
  | "missing-video-frame"
  | "missing-audio-data"
  | "codec-unsupported";

/**
 * Returns true iff the browser exposes the WebCodecs surface we need for the
 * fast MP4 export path: HW-backed VideoEncoder + AudioEncoder, plus a way to
 * stream PCM out of the offscreen video. We also need AAC encoding support.
 */
export function isWebCodecsExportSupported(): boolean {
  return webCodecsUnavailableReason() === null;
}

/**
 * Same check as isWebCodecsExportSupported but reports *why* if the surface
 * is missing. Lets the UI explain "this site needs HTTPS for WebCodecs"
 * instead of silently downgrading to ffmpeg.wasm.
 *
 * The most common gotcha is `insecure-context` — Chrome / Edge hide the
 * VideoEncoder / AudioEncoder constructors entirely on plain http:// pages
 * that aren't localhost, so just checking `typeof` is enough to surface it.
 */
export function webCodecsUnavailableReason(): WebCodecsUnavailableReason | null {
  if (typeof window === "undefined") return "ssr";
  if (!window.isSecureContext) return "insecure-context";
  if (typeof window.VideoEncoder === "undefined") return "missing-video-encoder";
  if (typeof window.AudioEncoder === "undefined") return "missing-audio-encoder";
  if (typeof window.VideoFrame === "undefined") return "missing-video-frame";
  if (typeof window.AudioData === "undefined") return "missing-audio-data";
  return null;
}

/**
 * Quickly check the codec strings we plan to feed mp4-muxer are actually
 * supported by the running browser, before we commit to this code path.
 */
export async function probeWebCodecsConfig(
  width: number,
  height: number,
  fps: number
): Promise<boolean> {
  if (!isWebCodecsExportSupported()) return false;
  try {
    const video = await VideoEncoder.isConfigSupported({
      codec: "avc1.42E01F",
      width,
      height,
      bitrate: 6_000_000,
      framerate: fps,
      avc: { format: "avc" },
    });
    if (!video.supported) return false;
    const audio = await AudioEncoder.isConfigSupported({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    return !!audio.supported;
  } catch {
    return false;
  }
}

/**
 * Burn captions into the source video and produce an MP4 entirely through
 * WebCodecs. The video frames are HW-encoded (AVC1) and the audio is
 * HW-encoded (AAC-LC), skipping the ffmpeg.wasm transcode step.
 *
 * Pipeline:
 *   1. mount an offscreen <video src> + render frames to a canvas
 *   2. VideoEncoder encodes the canvas into AVC chunks → muxer
 *   3. an AudioContext + ScriptProcessor taps the source audio into PCM
 *      AudioData frames → AudioEncoder → AAC chunks → muxer
 *   4. mp4-muxer finalises an MP4 buffer
 */
export async function exportBurnedVideoWebCodecs(
  opts: WebCodecsExportOptions
): Promise<WebCodecsExportResult> {
  const { videoUrl, segments, speakers, width, height } = opts;
  const fps = opts.fps ?? 30;
  const videoBitrate = opts.videoBitrate ?? 6_000_000;
  const audioBitrate = opts.audioBitrate ?? 128_000;

  const offscreen = document.createElement("video");
  offscreen.src = videoUrl;
  offscreen.preload = "auto";
  offscreen.playsInline = true;
  // IMPORTANT: don't mute. Chrome skips audio decoding on muted <video>, so
  // the ScriptProcessor below would never receive PCM samples and the
  // exported MP4 would have a silent audio track. createMediaElementSource
  // already reroutes audio away from the speakers, and the WebAudio graph
  // below terminates through a 0-gain node, so nothing reaches the user.
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

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width,
      height,
      frameRate: fps,
    },
    audio: {
      codec: "aac",
      sampleRate: 48000,
      numberOfChannels: 2,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let firstVideoTs: number | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error("[webcodecs] video encoder error", e);
    },
  });
  videoEncoder.configure({
    codec: "avc1.42E01F",
    width,
    height,
    bitrate: videoBitrate,
    framerate: fps,
    avc: { format: "avc" },
  });

  let firstAudioTs: number | null = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta);
    },
    error: (e) => {
      console.error("[webcodecs] audio encoder error", e);
    },
  });
  audioEncoder.configure({
    codec: "mp4a.40.2",
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: audioBitrate,
  });

  // Audio capture pipeline: source -> ScriptProcessor (PCM out) -> muted gain
  // so processing fires without the user hearing the export.
  const AudioCtor: typeof AudioContext =
    window.AudioContext ??
    // @ts-expect-error - webkit prefix on older Safari
    window.webkitAudioContext;
  const audioCtx = new AudioCtor({ sampleRate: 48000 });
  const audioSource = audioCtx.createMediaElementSource(offscreen);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- AudioWorklet would be cleaner but ScriptProcessor is universally available
  const proc = audioCtx.createScriptProcessor(4096, 2, 2);
  const muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  audioSource.connect(proc);
  proc.connect(muteGain).connect(audioCtx.destination);

  let audioSampleCount = 0;
  proc.onaudioprocess = (e) => {
    const left = e.inputBuffer.getChannelData(0);
    const right =
      e.inputBuffer.numberOfChannels > 1
        ? e.inputBuffer.getChannelData(1)
        : left;
    const frames = left.length;
    // Planar f32 layout: [L L L ... R R R]
    const planar = new Float32Array(frames * 2);
    planar.set(left, 0);
    planar.set(right, frames);
    const timestamp = (audioSampleCount * 1_000_000) / 48000;
    if (firstAudioTs == null) firstAudioTs = timestamp;
    audioSampleCount += frames;
    try {
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfChannels: 2,
        numberOfFrames: frames,
        timestamp,
        data: planar.buffer,
      });
      audioEncoder.encode(audioData);
      audioData.close();
    } catch (err) {
      console.error("[webcodecs] AudioData build failed", err);
    }
  };

  if (audioCtx.state === "suspended") await audioCtx.resume();

  // Pin to start.
  offscreen.currentTime = 0;
  await new Promise<void>((resolve) => {
    const handler = () => {
      offscreen.removeEventListener("seeked", handler);
      resolve();
    };
    offscreen.addEventListener("seeked", handler);
  });

  const recordStartedAt = performance.now();
  let frameIndex = 0;

  const drawAndEncode = () => {
    ctx.drawImage(offscreen, 0, 0, width, height);
    const seg = currentSegment(segments, offscreen.currentTime);
    if (seg && seg.text.trim()) {
      const sp =
        (seg.speakerId && speakers.find((p) => p.id === seg.speakerId)) ||
        speakers[0] ||
        FALLBACK_STYLE;
      drawCaption(ctx, width, height, seg.text, sp);
    }
    const timestamp = Math.round((performance.now() - recordStartedAt) * 1000);
    if (firstVideoTs == null) firstVideoTs = timestamp;
    const frame = new VideoFrame(canvas, { timestamp });
    // Keyframe every 60 frames (~2 s @ 30 fps) for seekability.
    const keyFrame = frameIndex % 60 === 0;
    videoEncoder.encode(frame, { keyFrame });
    frame.close();
    frameIndex++;
  };

  drawAndEncode();

  const ended = new Promise<void>((resolve) => {
    const onEnded = () => {
      offscreen.removeEventListener("ended", onEnded);
      resolve();
    };
    offscreen.addEventListener("ended", onEnded);
  });

  await offscreen.play();

  let raf = 0;
  const duration = offscreen.duration;
  const tick = () => {
    if (opts.signal?.aborted) {
      cancelAnimationFrame(raf);
      return;
    }
    drawAndEncode();
    opts.onProgress?.(
      "recording",
      duration > 0 ? Math.min(1, offscreen.currentTime / duration) : 0
    );
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  await ended;
  cancelAnimationFrame(raf);

  // Flush remaining frames + audio.
  proc.onaudioprocess = null;
  try {
    audioSource.disconnect();
    proc.disconnect();
    muteGain.disconnect();
  } catch {
    /* noop */
  }

  await videoEncoder.flush();
  videoEncoder.close();
  await audioEncoder.flush();
  audioEncoder.close();

  muxer.finalize();
  const buffer = muxer.target.buffer;

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
    await audioCtx.close();
  } catch {
    /* noop */
  }

  return { blob: new Blob([buffer], { type: "video/mp4" }) };
}
