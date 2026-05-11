"use client";

import { useEffect, useRef } from "react";
import { Trash2, Plus, UserCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProject } from "@/store/project-store";
import { cn, formatTime } from "@/lib/utils";

interface Props {
  onSeek: (time: number) => void;
}

export function CaptionList({ onSeek }: Props) {
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const activeSegmentId = useProject((s) => s.activeSegmentId);
  const diarizationEnabled = useProject((s) => s.diarizationEnabled);
  const updateSegment = useProject((s) => s.updateSegment);
  const deleteSegment = useProject((s) => s.deleteSegment);
  const insertSegmentAfter = useProject((s) => s.insertSegmentAfter);
  const setActiveSegment = useProject((s) => s.setActiveSegment);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Auto-scroll active row into view
  useEffect(() => {
    if (!activeSegmentId) return;
    const node = rowRefs.current.get(activeSegmentId);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeSegmentId]);

  return (
    <div
      ref={containerRef}
      className="scrollbar-thin flex h-full flex-col overflow-y-auto rounded-xl border border-border/60 bg-card/40 backdrop-blur"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-card/80 px-4 py-3 backdrop-blur">
        <div>
          <div className="text-sm font-semibold">字幕逐句校對</div>
          <div className="text-xs text-muted-foreground">
            點時間軸或字幕跳轉 · 雙擊文字編輯
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{segments.length} 句</div>
      </div>

      <div className="flex-1 divide-y divide-border/50">
        {segments.length === 0 && (
          <div className="px-6 py-16 text-center text-sm text-muted-foreground">
            尚無字幕，請先回首頁上傳影片並生成字幕。
          </div>
        )}

        {segments.map((seg) => {
          const speaker = speakers.find((sp) => sp.id === seg.speakerId);
          const isActive = seg.id === activeSegmentId;
          return (
            <div
              key={seg.id}
              ref={(el) => {
                if (el) rowRefs.current.set(seg.id, el);
                else rowRefs.current.delete(seg.id);
              }}
              onClick={() => {
                setActiveSegment(seg.id);
                onSeek(seg.start);
              }}
              className={cn(
                "group relative cursor-pointer px-4 py-3 transition-colors hover:bg-accent/30",
                isActive &&
                  "bg-gradient-to-r from-fuchsia-500/10 via-violet-500/5 to-transparent"
              )}
              style={{
                boxShadow: isActive
                  ? `inset 3px 0 0 ${speaker?.color ?? "#a855f7"}`
                  : undefined,
              }}
            >
              <div className="flex items-start gap-3">
                <div className="flex w-20 shrink-0 flex-col text-[10px] font-mono leading-tight text-muted-foreground">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(seg.start);
                    }}
                    className="text-left hover:text-foreground"
                  >
                    {formatTime(seg.start)}
                  </button>
                  <div className="opacity-50">↓</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(seg.end);
                    }}
                    className="text-left hover:text-foreground"
                  >
                    {formatTime(seg.end)}
                  </button>
                </div>

                <div className="flex flex-1 flex-col gap-2">
                  <Textarea
                    value={seg.text}
                    onChange={(e) =>
                      updateSegment(seg.id, { text: e.target.value })
                    }
                    onClick={(e) => e.stopPropagation()}
                    onFocus={() => setActiveSegment(seg.id)}
                    rows={2}
                    className={cn(
                      "resize-none border-transparent bg-background/40 text-sm focus-visible:border-input",
                      isActive && "border-input bg-background/70"
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {diarizationEnabled && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={seg.speakerId ?? "__none__"}
                          onValueChange={(v) =>
                            updateSegment(seg.id, {
                              speakerId: v === "__none__" ? null : v,
                            })
                          }
                        >
                          <SelectTrigger className="h-7 w-[160px] text-xs">
                            <UserCircle2
                              className="mr-1 h-3.5 w-3.5"
                              style={{ color: speaker?.color }}
                            />
                            <SelectValue placeholder="指派講者" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">未指派</SelectItem>
                            {speakers.map((sp) => (
                              <SelectItem key={sp.id} value={sp.id}>
                                <span
                                  className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                                  style={{ background: sp.color }}
                                />
                                {sp.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1"
                    >
                      <Input
                        type="number"
                        step={0.01}
                        min={0}
                        value={seg.start.toFixed(2)}
                        onChange={(e) =>
                          updateSegment(seg.id, {
                            start: Math.max(0, parseFloat(e.target.value) || 0),
                          })
                        }
                        className="h-7 w-20 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">→</span>
                      <Input
                        type="number"
                        step={0.01}
                        min={0}
                        value={seg.end.toFixed(2)}
                        onChange={(e) =>
                          updateSegment(seg.id, {
                            end: Math.max(
                              seg.start + 0.05,
                              parseFloat(e.target.value) || seg.end
                            ),
                          })
                        }
                        className="h-7 w-20 text-xs"
                      />
                    </div>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          insertSegmentAfter(seg.id);
                        }}
                        title="在此句之後插入新字幕"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSegment(seg.id);
                        }}
                        title="刪除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
