"use client";

import { useEffect, useState } from "react";
import { Download, Film, Loader2, FileText, Cpu, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProject } from "@/store/project-store";
import {
  exportBurnedVideo,
  probePipeline,
  segmentsToSRT,
  type ExportFormat,
  type ExportPhase,
  type ExportPipeline,
} from "@/lib/export-video";

const PHASE_LABEL: Record<ExportPhase, string> = {
  recording: "錄製",
  transcoding: "轉檔",
};

export function ExportBar() {
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const videoSize = useProject((s) => s.videoSize);
  const videoUrl = useProject((s) => s.videoUrl);
  const videoFile = useProject((s) => s.videoFile);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<ExportPhase>("recording");
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [pipeline, setPipeline] = useState<ExportPipeline | null>(null);

  // Probe which pipeline the current format+resolution will actually use,
  // so the UI can show a "GPU 加速" badge before the user clicks export.
  useEffect(() => {
    let cancelled = false;
    probePipeline(format, videoSize.width || 1280, videoSize.height || 720, 30)
      .then((p) => {
        if (!cancelled) setPipeline(p);
      })
      .catch(() => {
        if (!cancelled) setPipeline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [format, videoSize.width, videoSize.height]);

  const downloadSRT = () => {
    const srt = segmentsToSRT(segments);
    const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${videoFile?.name?.replace(/\.[^.]+$/, "") || "captions"}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const burnAndDownload = async () => {
    if (!videoUrl) {
      toast.error("找不到影片來源");
      return;
    }
    setBusy(true);
    setProgress(0);
    setPhase("recording");
    const toastId = toast.loading(
      format === "mp4"
        ? "背景錄製中… 完成後會自動轉成 MP4，預覽不受影響"
        : "背景錄製中… 預覽不受影響"
    );
    try {
      const result = await exportBurnedVideo({
        videoUrl,
        segments,
        speakers,
        width: videoSize.width || 1280,
        height: videoSize.height || 720,
        fps: 30,
        format,
        onProgress: (ph, r) => {
          setPhase(ph);
          setProgress(r * 100);
          if (ph === "transcoding") {
            toast.loading("轉檔為 MP4 中…", { id: toastId });
          }
        },
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${
        videoFile?.name?.replace(/\.[^.]+$/, "") || "video"
      }-captioned.${result.ext}`;
      a.click();
      URL.revokeObjectURL(url);
      const pipelineLabel =
        result.pipeline === "webcodecs"
          ? "GPU"
          : result.pipeline === "ffmpeg"
          ? "ffmpeg.wasm"
          : "WebM";
      toast.success(
        `匯出完成 · ${result.ext.toUpperCase()} (${pipelineLabel})`,
        { id: toastId }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`匯出失敗：${msg}`, { id: toastId });
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-xl md:flex-row md:items-center md:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Film className="h-4 w-4 text-fuchsia-400" />
          燒錄輸出
          {pipeline === "webcodecs" && (
            <span
              className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300"
              title="WebCodecs: 硬體加速 AVC + AAC，省去 WebM 中介轉檔"
            >
              <Zap className="h-2.5 w-2.5" />
              GPU 加速
            </span>
          )}
          {pipeline === "ffmpeg" && (
            <span
              className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300"
              title="此瀏覽器不支援 WebCodecs，將使用 ffmpeg.wasm 做 MP4 轉檔"
            >
              <Cpu className="h-2.5 w-2.5" />
              CPU
            </span>
          )}
          {busy && (
            <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
              </span>
              背景錄製
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {format === "mp4" && pipeline === "webcodecs"
            ? "WebCodecs 直接編 H.264 + AAC、HW 加速，無 WebM 中介轉檔"
            : format === "mp4"
            ? "本機背景錄製 + ffmpeg.wasm 轉檔，輸出通用 MP4（H.264 / AAC）"
            : "本機背景錄製，輸出 WebM（VP9 / Opus，較快）"}
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        {busy && (
          <div className="flex w-56 items-center gap-2">
            <span className="w-10 shrink-0 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
              {PHASE_LABEL[phase]}
            </span>
            <Progress value={progress} className="flex-1" />
            <span className="w-9 text-right font-mono text-xs">
              {Math.round(progress)}%
            </span>
          </div>
        )}

        <Select
          value={format}
          onValueChange={(v) => setFormat(v as ExportFormat)}
          disabled={busy}
        >
          <SelectTrigger className="h-9 w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mp4">MP4 · H.264</SelectItem>
            <SelectItem value="webm">WebM · 快速</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={downloadSRT}
          disabled={busy || segments.length === 0}
        >
          <FileText className="h-4 w-4" />
          下載 .srt
        </Button>
        <Button
          variant="gradient"
          size="sm"
          onClick={burnAndDownload}
          disabled={busy || segments.length === 0}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          燒錄並下載
        </Button>
      </div>
    </div>
  );
}
