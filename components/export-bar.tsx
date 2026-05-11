"use client";

import { useState } from "react";
import { Download, Film, Loader2, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useProject } from "@/store/project-store";
import { exportBurnedVideo, segmentsToSRT } from "@/lib/export-video";

interface Props {
  getVideo: () => HTMLVideoElement | null;
}

export function ExportBar({ getVideo }: Props) {
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const videoSize = useProject((s) => s.videoSize);
  const videoFile = useProject((s) => s.videoFile);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

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
    const video = getVideo();
    if (!video) {
      toast.error("找不到影片元素");
      return;
    }
    setBusy(true);
    setProgress(0);
    const t = toast.loading("正在燒錄字幕到影片…");
    try {
      const blob = await exportBurnedVideo({
        video,
        segments,
        speakers,
        width: videoSize.width || video.videoWidth || 1280,
        height: videoSize.height || video.videoHeight || 720,
        fps: 30,
        onProgress: (r) => setProgress(r * 100),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${
        videoFile?.name?.replace(/\.[^.]+$/, "") || "video"
      }-captioned.webm`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("匯出完成", { id: t });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`匯出失敗：${msg}`, { id: t });
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
        </div>
        <div className="text-xs text-muted-foreground">
          匯出時會即時播放影片並錄製為 WebM，影片不會傳到伺服器
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        {busy && (
          <div className="flex w-44 items-center gap-2">
            <Progress value={progress} className="flex-1" />
            <span className="w-9 text-right font-mono text-xs">
              {Math.round(progress)}%
            </span>
          </div>
        )}
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
          燒錄並下載影片
        </Button>
      </div>
    </div>
  );
}
