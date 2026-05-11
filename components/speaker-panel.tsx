"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DEFAULT_FONTS } from "@/lib/types";
import { useProject } from "@/store/project-store";

export function SpeakerPanel() {
  const speakers = useProject((s) => s.speakers);
  const addSpeaker = useProject((s) => s.addSpeaker);
  const removeSpeaker = useProject((s) => s.removeSpeaker);
  const updateSpeaker = useProject((s) => s.updateSpeaker);

  const multiSpeaker = speakers.length > 1;

  return (
    <div className="scrollbar-thin flex h-full flex-col overflow-y-auto rounded-xl border border-border/60 bg-card/40 backdrop-blur">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-card/80 px-4 py-3 backdrop-blur">
        <div>
          <div className="text-sm font-semibold">
            {multiSpeaker ? "講者樣式" : "字幕樣式"}
          </div>
          <div className="text-xs text-muted-foreground">
            {multiSpeaker
              ? "每位講者可獨立設定底色、字邊框、字填滿"
              : "編輯預設樣式，或新增更多講者建立差異樣式"}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 p-3">
        {speakers.map((sp) => (
          <div
            key={sp.id}
            className="rounded-lg border border-border/60 bg-background/50 p-3"
            style={{
              boxShadow: `inset 3px 0 0 ${sp.color}`,
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="h-7 w-7 rounded-full ring-2 ring-border transition-all hover:scale-105"
                    style={{ background: sp.color }}
                    title="變更代表色"
                  />
                </PopoverTrigger>
                <PopoverContent className="w-56 p-3">
                  <Label className="mb-2 block text-xs">代表色</Label>
                  <Input
                    type="color"
                    value={sp.color}
                    onChange={(e) =>
                      updateSpeaker(sp.id, { color: e.target.value })
                    }
                    className="h-8 w-full cursor-pointer"
                  />
                </PopoverContent>
              </Popover>
              <Input
                value={sp.name}
                onChange={(e) =>
                  updateSpeaker(sp.id, { name: e.target.value })
                }
                className="h-8 text-sm font-medium"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeSpeaker(sp.id)}
                disabled={speakers.length <= 1}
                title="移除講者"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Preview chip */}
            <div className="mb-3 flex items-center justify-center rounded-md bg-[radial-gradient(circle_at_30%_30%,#1f2937,#0b0d12)] p-4">
              <PreviewBubble sp={sp} />
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <ColorRow
                label="底色"
                value={sp.background}
                onChange={(v) =>
                  updateSpeaker(sp.id, { background: v })
                }
                allowAlpha
              />
              <ColorRow
                label="字邊框"
                value={sp.stroke}
                onChange={(v) =>
                  updateSpeaker(sp.id, { stroke: v })
                }
              />
              <ColorRow
                label="字填滿"
                value={sp.fill}
                onChange={(v) => updateSpeaker(sp.id, { fill: v })}
              />
            </div>

            <div className="mt-3 space-y-2 text-xs">
              <Row label={`字邊框寬度 · ${sp.strokeWidth}px`}>
                <Slider
                  value={[sp.strokeWidth]}
                  min={0}
                  max={12}
                  step={0.5}
                  onValueChange={(v) =>
                    updateSpeaker(sp.id, { strokeWidth: v[0] })
                  }
                />
              </Row>
              <Row label={`字級 · ${sp.fontSize}px`}>
                <Slider
                  value={[sp.fontSize]}
                  min={18}
                  max={96}
                  step={1}
                  onValueChange={(v) =>
                    updateSpeaker(sp.id, { fontSize: v[0] })
                  }
                />
              </Row>
              <Row label={`字重 · ${sp.fontWeight}`}>
                <Slider
                  value={[sp.fontWeight]}
                  min={300}
                  max={900}
                  step={100}
                  onValueChange={(v) =>
                    updateSpeaker(sp.id, { fontWeight: v[0] })
                  }
                />
              </Row>
              <Row label="字型">
                <Select
                  value={sp.fontFamily}
                  onValueChange={(v) =>
                    updateSpeaker(sp.id, { fontFamily: v })
                  }
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_FONTS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f.split(",")[0].replace(/['"]/g, "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <div className="grid grid-cols-2 gap-2">
                <Row label={`水平內距 · ${sp.paddingX}`}>
                  <Slider
                    value={[sp.paddingX]}
                    min={0}
                    max={48}
                    step={1}
                    onValueChange={(v) =>
                      updateSpeaker(sp.id, { paddingX: v[0] })
                    }
                  />
                </Row>
                <Row label={`垂直內距 · ${sp.paddingY}`}>
                  <Slider
                    value={[sp.paddingY]}
                    min={0}
                    max={32}
                    step={1}
                    onValueChange={(v) =>
                      updateSpeaker(sp.id, { paddingY: v[0] })
                    }
                  />
                </Row>
              </div>
              <Row label={`圓角 · ${sp.borderRadius}px`}>
                <Slider
                  value={[sp.borderRadius]}
                  min={0}
                  max={32}
                  step={1}
                  onValueChange={(v) =>
                    updateSpeaker(sp.id, { borderRadius: v[0] })
                  }
                />
              </Row>
            </div>
          </div>
        ))}

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => addSpeaker()}
        >
          <Plus className="h-3.5 w-3.5" />
          新增講者
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
  allowAlpha,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allowAlpha?: boolean;
}) {
  // Convert any value to a hex for color input + show raw for alpha editing
  const isRgba = value.startsWith("rgba(");
  const hex = isRgba ? rgbaToHex(value) : value;
  const alpha = isRgba ? parseFloat(value.match(/[\d.]+\)$/)?.[0] ?? "1") : 1;
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const v = e.target.value;
            if (allowAlpha) {
              onChange(hexToRgba(v, alpha));
            } else {
              onChange(v);
            }
          }}
          className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
        />
        {allowAlpha && (
          <Slider
            value={[alpha * 100]}
            min={0}
            max={100}
            step={5}
            onValueChange={(v) => onChange(hexToRgba(hex, v[0] / 100))}
            className="flex-1"
          />
        )}
      </div>
    </div>
  );
}

function rgbaToHex(rgba: string): string {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "#000000";
  const [, r, g, b] = m;
  return (
    "#" +
    [r, g, b]
      .map((n) => parseInt(n, 10).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function PreviewBubble({ sp }: { sp: ReturnType<typeof useProject.getState>["speakers"][number] }) {
  return (
    <span
      style={{
        background: sp.background,
        color: sp.fill,
        WebkitTextStroke: `${sp.strokeWidth}px ${sp.stroke}`,
        paintOrder: "stroke fill",
        fontFamily: sp.fontFamily,
        fontWeight: sp.fontWeight,
        fontSize: Math.min(sp.fontSize * 0.55, 28),
        padding: `${sp.paddingY * 0.6}px ${sp.paddingX * 0.6}px`,
        borderRadius: sp.borderRadius,
        display: "inline-block",
      }}
    >
      {sp.name} · Sample 字幕預覽
    </span>
  );
}
