"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UploadCloud,
  Wand2,
  Loader2,
  AudioLines,
  Languages,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractAudio } from "@/lib/ffmpeg-client";
import { transcribeAudio } from "@/lib/transcribe";
import { useProject } from "@/store/project-store";
import { cn, formatShort } from "@/lib/utils";

type Stage =
  | "idle"
  | "loading-ffmpeg"
  | "extracting"
  | "queued"
  | "retrying"
  | "transcribing"
  | "done";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "等待影片",
  "loading-ffmpeg": "載入 FFmpeg.wasm…",
  extracting: "在瀏覽器內分離音訊…",
  queued: "排隊中…",
  retrying: "連線中斷，自動重試…",
  transcribing: "送至 Whisper Gateway 轉文字…",
  done: "完成 ✓",
};

export function UploadCard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [queueAhead, setQueueAhead] = useState(0);
  const [retry, setRetry] = useState<{ attempt: number; max: number } | null>(
    null
  );
  const [hovered, setHovered] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const setVideo = useProject((s) => s.setVideo);
  const setSegments = useProject((s) => s.setSegments);
  const setVideoMeta = useProject((s) => s.setVideoMeta);
  const replaceSpeakers = useProject((s) => s.replaceSpeakers);
  const language = useProject((s) => s.language);
  const setLanguage = useProject((s) => s.setLanguage);

  const probeVideoMeta = useCallback(
    (f: File) =>
      new Promise<{ duration: number; width: number; height: number }>(
        (resolve) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          const url = URL.createObjectURL(f);
          video.src = url;
          video.onloadedmetadata = () => {
            const meta = {
              duration: video.duration,
              width: video.videoWidth,
              height: video.videoHeight,
            };
            URL.revokeObjectURL(url);
            resolve(meta);
          };
          video.onerror = () => {
            URL.revokeObjectURL(url);
            resolve({ duration: 0, width: 1280, height: 720 });
          };
        }
      ),
    []
  );

  const handleFile = useCallback(async (f: File) => {
    if (!f.type.startsWith("video/")) {
      toast.error("請選擇影片檔案");
      return;
    }
    setFile(f);
  }, []);

  const onPickClick = () => inputRef.current?.click();
  const onPickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setHovered(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  function humaniseSpeakerLabel(label: string, idx: number) {
    const m = label.match(/(\d+)/);
    if (m) return `講者 ${parseInt(m[1], 10) + 1}`;
    return `講者 ${idx + 1}`;
  }

  const start = async () => {
    if (!file) {
      toast.error("先選擇影片");
      return;
    }
    try {
      setProgress(0);
      setStage("loading-ffmpeg");
      const meta = await probeVideoMeta(file);
      const url = URL.createObjectURL(file);
      setVideo(file, url);
      setVideoMeta(meta.duration, meta.width || 1280, meta.height || 720);

      setStage("extracting");
      const audio = await extractAudio(file, (r) => setProgress(r * 100));

      setStage("transcribing");
      setProgress(0);
      // Whisper doesn't have separate zh-Hant / zh-Hans codes — both map
      // onto "zh". The script choice is applied as a post-process via OpenCC.
      const gatewayLang =
        language === "auto"
          ? undefined
          : language === "zh-Hant" || language === "zh-Hans"
            ? "zh"
            : language;
      const convertTo: "traditional" | "simplified" | undefined =
        language === "zh-Hant"
          ? "traditional"
          : language === "zh-Hans"
            ? "simplified"
            : undefined;

      const { segments, speakerLabels } = await transcribeAudio(audio, {
        model: "whisper-1",
        language: gatewayLang,
        diarize: true,
        convertTo,
        onQueueStatus: ({ ahead }) => {
          setQueueAhead(ahead);
          if (ahead > 0) setStage("queued");
        },
        onProcessing: () => {
          setQueueAhead(0);
          setRetry(null);
          setStage("transcribing");
        },
        onRetry: ({ attempt, maxAttempts }) => {
          setRetry({ attempt, max: maxAttempts });
          setStage("retrying");
        },
      });

      // Materialise speakers from the backend's diarization result. If the
      // backend found multiple speakers, each gets its own SpeakerStyle. If
      // only one (or none), we keep a single default style.
      let finalSegments = segments;
      if (speakerLabels.length > 1) {
        const speakerHints = speakerLabels.map((label, i) => ({
          id: `spk-${label}`,
          name: humaniseSpeakerLabel(label, i),
        }));
        replaceSpeakers(speakerHints);
        const labelToId = new Map(
          speakerLabels.map((label) => [label, `spk-${label}`])
        );
        finalSegments = segments.map((s) =>
          s.speakerId && labelToId.has(s.speakerId)
            ? { ...s, speakerId: labelToId.get(s.speakerId)! }
            : { ...s, speakerId: null }
        );
      } else {
        replaceSpeakers([{ id: "spk-default", name: "預設樣式" }]);
        finalSegments = segments.map((s) => ({ ...s, speakerId: null }));
      }

      setSegments(finalSegments);

      setStage("done");
      toast.success(
        `生成 ${finalSegments.length} 句字幕${
          speakerLabels.length > 1
            ? ` · 偵測到 ${speakerLabels.length} 位講者`
            : ""
        }`
      );
      router.push("/editor");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`處理失敗：${msg}`);
      setStage("idle");
      setProgress(0);
      setQueueAhead(0);
      setRetry(null);
    }
  };

  const busy = stage !== "idle" && stage !== "done";

  return (
    <Card className="border-border/60 bg-card/60 p-8 backdrop-blur-xl">
      <div className="space-y-6">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setHovered(true);
          }}
          onDragLeave={() => setHovered(false)}
          onDrop={onDrop}
          onClick={onPickClick}
          className={cn(
            "group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/60 bg-background/40 px-6 py-12 text-center transition-all",
            hovered &&
              "border-fuchsia-400/80 bg-fuchsia-500/5 shadow-inner shadow-fuchsia-500/10",
            file && "border-border bg-background/60"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={onPickChange}
          />
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 via-fuchsia-500/20 to-cyan-500/20 ring-1 ring-border">
            <UploadCloud className="h-7 w-7 text-fuchsia-300" />
          </div>
          <div className="text-base font-medium">
            {file ? file.name : "拖曳影片到此 · 或點擊選擇檔案"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {file
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB · 音訊將在瀏覽器內擷取，影片本身不會被上傳`
              : "支援 MP4 / MOV / WebM / MKV 等。處理過程影片只存在於你的瀏覽器內。"}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Languages className="h-3.5 w-3.5" /> 字幕語言
          </Label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自動偵測</SelectItem>
              <SelectItem value="zh-Hant">中文（繁體）</SelectItem>
              <SelectItem value="zh-Hans">中文（簡體）</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ja">日本語</SelectItem>
              <SelectItem value="ko">한국어</SelectItem>
              <SelectItem value="es">Español</SelectItem>
            </SelectContent>
          </Select>
          <div className="pt-1 text-[11px] text-muted-foreground">
            講者分離已預設啟用 — 多人對話會自動建立不同樣式
          </div>
        </div>

        {busy && (
          <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Loader2
                  className={cn(
                    "h-4 w-4 animate-spin",
                    stage === "retrying" ? "text-amber-400" : "text-fuchsia-400"
                  )}
                />
                <span>
                  {stage === "queued"
                    ? queueAhead > 0
                      ? `排隊中 — 前面還有 ${queueAhead} 個`
                      : "排隊中…"
                    : stage === "retrying" && retry
                      ? `連線中斷，自動重試（第 ${retry.attempt} / ${retry.max} 次）`
                      : STAGE_LABEL[stage]}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {stage === "queued"
                  ? "等待 Gateway 空檔"
                  : stage === "transcribing"
                    ? "上傳音訊到 Gateway"
                    : stage === "retrying"
                      ? "稍候片刻…"
                      : `${Math.round(progress)}%`}
              </span>
            </div>
            <Progress
              value={
                stage === "queued" || stage === "retrying"
                  ? 100
                  : stage === "transcribing"
                    ? 100
                    : progress
              }
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {file ? (
              <span className="inline-flex items-center gap-1.5">
                <AudioLines className="h-3.5 w-3.5 text-cyan-400" />
                準備：{file.name} · 預估處理 ≈ {formatShort(
                  (file.size / 1024 / 1024) * 0.6
                )}
              </span>
            ) : (
              "Tip: 一切都在本機處理，僅音訊（< 1MB/min）會送出。"
            )}
          </div>
          <Button
            variant="gradient"
            size="lg"
            disabled={!file || busy}
            onClick={start}
            className="min-w-[180px]"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                處理中…
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                開始生成字幕
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}
