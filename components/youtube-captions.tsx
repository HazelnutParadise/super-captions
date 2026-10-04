"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useProject } from "@/store/project-store";
import { requestYouTubeCaptions } from "@/lib/youtube-client";
import type { YouTubeCaptionTrack } from "@/lib/youtube-captions";

export function YouTubeCaptions() {
  const url = useProject((s) => s.youtubeUrl);
  const filename = useProject((s) => s.videoFile?.name ?? "youtube-video.mp4");
  return url ? <CCDownloads key={url} url={url} filename={filename} /> : null;
}

function CCDownloads({ url, filename }: { url: string; filename: string }) {
  const [tracks, setTracks] = useState<YouTubeCaptionTrack[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const downloadRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestYouTubeCaptions(url, controller.signal).then(result => {
      if (controller.signal.aborted || !("tracks" in result)) return;
      setTracks(result.tracks);
      setSelected(result.tracks[0]?.id ?? "");
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "取得 CC 失敗，請稍後再試");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); downloadRequest.current?.abort(); };
  }, [url, reload]);

  const download = async () => {
    if (!selected || downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    setError(null);
    try {
      const result = await requestYouTubeCaptions(url, controller.signal, selected);
      if (controller.signal.aborted || !("srt" in result)) return;
      const blobUrl = URL.createObjectURL(new Blob([result.srt], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${filename.replace(/\.[^.]+$/, "")}-youtube-${result.track.source === "manual" ? "cc" : "auto"}-${result.track.language.replace(/[^A-Za-z0-9_-]/g, "_")}.srt`;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "CC 下載失敗，請稍後再試");
        if (e instanceof Error && "status" in e && e.status === 404) {
          setTracks([]);
          setSelected("");
        }
      }
    } finally {
      downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4" aria-label="YouTube CC 字幕">
      <div className="mb-2 text-sm font-medium">YouTube CC 字幕</div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">保留 YouTube 的字幕與時間軸。上方的生成字幕可編輯、燒錄，兩個版本分別下載。</p>
      {loading ? (
        <div role="status" className="h-9 animate-pulse rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground motion-reduce:animate-none">正在讀取可用的 CC 字幕…</div>
      ) : tracks.length ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor="youtube-cc-track" className="block text-xs text-muted-foreground">CC 語言與來源</label>
            <select id="youtube-cc-track" value={selected} onChange={e => { setSelected(e.target.value); setError(null); }} disabled={downloading}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {tracks.map(track => <option key={track.id} value={track.id}>{track.name} ({track.language}) · {track.source === "manual" ? "原始 CC" : "YouTube 自動字幕"}</option>)}
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={download} disabled={downloading || !selected} className="shrink-0">{downloading ? "下載 CC 中…" : "下載 YouTube CC .srt"}</Button>
        </div>
      ) : !error ? (
        <p className="text-sm text-muted-foreground">這支影片沒有可下載的 CC，可使用上方的生成字幕。</p>
      ) : null}
      {error ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <p role="alert" className="text-sm text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={() => {
            if (tracks.length) void download();
            else { setLoading(true); setError(null); setReload(r => r + 1); }
          }} disabled={downloading || loading} className="self-start shrink-0">重試 CC</Button>
        </div>
      ) : null}
    </div>
  );
}
