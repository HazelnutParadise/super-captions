"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Editable `MM:SS.mmm` (or `HH:MM:SS.mmm`) input.
 *
 * - Parses on blur / Enter — typing intermediate states is allowed without
 *   the value snapping back.
 * - Ignores the scroll wheel so users don't nudge timings by accident when
 *   scrolling the caption list.
 * - Bare numbers ("12.34") are accepted as seconds.
 */
export interface TimeInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange"
  > {
  value: number; // seconds
  onChange: (seconds: number) => void;
  min?: number;
  max?: number;
}

function pad(n: number, w: number) {
  return n.toString().padStart(w, "0");
}

export function formatTimecode(seconds: number, showHours = false): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (showHours || h > 0) {
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
  }
  return `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

export function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (!s) return null;

  // HH:MM:SS.mmm or MM:SS.mmm or SS.mmm — accept comma as ms separator too.
  const m = s.match(
    /^(?:(\d+):)?(?:(\d+):)?(\d+(?:[.,]\d{1,3})?)$/
  );
  if (m) {
    const [, a, b, c] = m;
    const sec = parseFloat(c.replace(",", "."));
    if (a != null && b != null) {
      return +a * 3600 + +b * 60 + sec;
    }
    if (a != null) {
      return +a * 60 + sec;
    }
    return sec;
  }
  return null;
}

export const TimeInput = React.forwardRef<HTMLInputElement, TimeInputProps>(
  function TimeInput(
    { value, onChange, min = 0, max, className, onBlur, onKeyDown, ...props },
    ref
  ) {
    const [draft, setDraft] = React.useState(() => formatTimecode(value));
    const [editing, setEditing] = React.useState(false);

    // Sync display when the canonical value changes from outside.
    React.useEffect(() => {
      if (!editing) setDraft(formatTimecode(value));
    }, [value, editing]);

    const commit = (text: string) => {
      const parsed = parseTimecode(text);
      if (parsed == null) {
        setDraft(formatTimecode(value));
        return;
      }
      const clamped = Math.max(
        min,
        max != null ? Math.min(max, parsed) : parsed
      );
      onChange(clamped);
      setDraft(formatTimecode(clamped));
    };

    return (
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        className={cn(
          "flex h-7 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs tabular-nums shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        value={draft}
        // Block accidental wheel-based scrolling on a focused input. text
        // inputs don't natively change on wheel, but blurring is a nice extra
        // safety net for the surrounding scroll container.
        onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          setEditing(false);
          commit(e.target.value);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(formatTimecode(value));
            (e.currentTarget as HTMLInputElement).blur();
          }
          onKeyDown?.(e);
        }}
        {...props}
      />
    );
  }
);
