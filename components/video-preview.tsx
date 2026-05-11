"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useProject } from "@/store/project-store";
import { drawCaption, currentSegment } from "@/lib/caption-render";
import { makeDefaultSpeaker, type SpeakerStyle } from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";

const FALLBACK_STYLE: SpeakerStyle = makeDefaultSpeaker("__fallback__", 0, "預設");

export interface VideoPreviewHandle {
  video: () => HTMLVideoElement | null;
  seek: (t: number) => void;
  play: () => Promise<void> | void;
  pause: () => void;
}

export const VideoPreview = forwardRef<VideoPreviewHandle, {}>(function VideoPreview(
  _props,
  exposedRef
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const videoUrl = useProject((s) => s.videoUrl);
  const videoSize = useProject((s) => s.videoSize);
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const activeSegmentId = useProject((s) => s.activeSegmentId);
  const setActiveSegment = useProject((s) => s.setActiveSegment);
  const storedDuration = useProject((s) => s.videoDuration);

  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  // Seed from the store's videoDuration so the slider has a real range even
  // before the <video> element fires loadedmetadata for the second time.
  const [duration, setDuration] = useState(storedDuration);

  useImperativeHandle(
    exposedRef,
    () => ({
      video: () => videoRef.current,
      seek: (t: number) => {
        const v = videoRef.current;
        if (v) v.currentTime = t;
      },
      play: () => videoRef.current?.play(),
      pause: () => videoRef.current?.pause(),
    }),
    []
  );

  useEffect(() => {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      const w = videoSize.width || canvas.clientWidth;
      const h = videoSize.height || canvas.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const t = video.currentTime;
      const seg = currentSegment(segments, t);
      if (seg && seg.text.trim()) {
        const speaker =
          (seg.speakerId && speakers.find((sp) => sp.id === seg.speakerId)) ||
          speakers[0] ||
          FALLBACK_STYLE;
        drawCaption(ctx, w, h, seg.text, speaker);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [segments, speakers, videoSize]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Pick up the metadata that may have arrived before this effect ran.
    if (isFinite(v.duration) && v.duration > 0) {
      setDuration(v.duration);
    }

    const onTime = () => {
      setTime(v.currentTime);
      const seg = currentSegment(segments, v.currentTime);
      if (seg && seg.id !== activeSegmentId) setActiveSegment(seg.id);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onDuration = () => {
      if (isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("loadedmetadata", onDuration);
    v.addEventListener("durationchange", onDuration);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("loadedmetadata", onDuration);
      v.removeEventListener("durationchange", onDuration);
    };
  }, [activeSegmentId, segments, setActiveSegment]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const max =
      (isFinite(v.duration) && v.duration > 0 ? v.duration : 0) ||
      duration ||
      storedDuration ||
      Infinity;
    v.currentTime = Math.max(0, Math.min(max, t));
    setTime(v.currentTime);
  };

  const onScrub = (vals: number[]) => seek(vals[0]);

  const activeSegRect = (() => {
    if (!segments.length || !duration) return null;
    const seg = currentSegment(segments, time);
    if (!seg) return null;
    return {
      left: (seg.start / duration) * 100,
      width: ((seg.end - seg.start) / duration) * 100,
    };
  })();

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/80 bg-black shadow-xl shadow-black/40">
        {videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              className="absolute inset-0 h-full w-full object-contain"
              muted={muted}
              playsInline
            />
            <canvas
              ref={overlayRef}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            尚未載入影片
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-card/60 p-3 backdrop-blur">
        <div className="relative h-2 w-full">
          <div className="absolute inset-0 rounded-full bg-primary/15" />
          {duration > 0 &&
            segments.map((s) => {
              const left = (s.start / duration) * 100;
              const w = ((s.end - s.start) / duration) * 100;
              const speaker = speakers.find((sp) => sp.id === s.speakerId);
              const bg = speaker?.color ?? "rgba(168,85,247,0.55)";
              return (
                <div
                  key={s.id}
                  className={cn(
                    "absolute top-0 h-2 rounded-sm opacity-50 transition-opacity hover:opacity-90",
                    s.id === activeSegmentId && "opacity-100 ring-2 ring-white"
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.2, w)}%`,
                    background: bg,
                  }}
                  onClick={() => seek(s.start)}
                  title={`${formatTime(s.start)} → ${formatTime(s.end)}`}
                />
              );
            })}
          {activeSegRect && (
            <div
              className="pointer-events-none absolute -inset-y-1 rounded-md ring-2 ring-fuchsia-400/80 shadow-[0_0_12px_rgba(232,121,249,0.55)]"
              style={{
                left: `${activeSegRect.left}%`,
                width: `${activeSegRect.width}%`,
              }}
            />
          )}
        </div>

        <Slider
          value={[time]}
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          onValueChange={onScrub}
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Button size="icon" variant="ghost" onClick={togglePlay}>
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMuted((m) => !m)}
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
              {formatTime(time)} <span className="opacity-50">/</span>{" "}
              {formatTime(duration)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {segments.length} 句字幕
          </div>
        </div>
      </div>
    </div>
  );
});
