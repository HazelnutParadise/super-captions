"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let _ffmpeg: FFmpeg | null = null;
let _loadPromise: Promise<FFmpeg> | null = null;

const CORE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export async function getFFmpeg(
  onProgress?: (ratio: number) => void
): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) =>
        onProgress(Math.max(0, Math.min(1, progress)))
      );
    }
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(
        `${CORE}/ffmpeg-core.wasm`,
        "application/wasm"
      ),
    });
    _ffmpeg = ffmpeg;
    return ffmpeg;
  })();

  return _loadPromise;
}

/**
 * Extract a mono 16k MP3 from the user's video, entirely in-browser.
 * Returns a File suitable for upload to /api/transcribe.
 */
export async function extractAudio(
  videoFile: File,
  onProgress?: (ratio: number) => void
): Promise<File> {
  const ffmpeg = await getFFmpeg();
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) =>
      onProgress(Math.max(0, Math.min(1, progress)))
    );
  }

  const ext = (videoFile.name.split(".").pop() ?? "mp4").toLowerCase();
  const inputName = `input.${ext}`;
  const outputName = "audio.mp3";

  await ffmpeg.writeFile(inputName, await fetchFile(videoFile));
  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    outputName,
  ]);

  const data = await ffmpeg.readFile(outputName);
  // cleanup
  try {
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);
  } catch {
    /* noop */
  }
  const bytes = data as Uint8Array;
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new File([arrayBuffer], "audio.mp3", { type: "audio/mpeg" });
}
