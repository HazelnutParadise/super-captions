"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const PAIRS = [
  { top: "影片不用上傳", bottom: "字幕也能自動上好" },
  { top: "影片不用上傳", bottom: "隱私就不會外洩" },
];

const INTERVAL_MS = 3500;

export function RotatingHeadline() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setIndex((i) => (i + 1) % PAIRS.length),
      INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, []);

  // Modulo guards against HMR / future array shrinkage leaving a stale index
  // out of bounds — without this we'd hit a destructure-of-undefined crash.
  const { top, bottom } = PAIRS[index % PAIRS.length];

  return (
    <h1
      className="text-4xl font-bold leading-tight tracking-tight md:text-5xl"
      style={{ perspective: "1000px" }}
    >
      <FlipPhrase text={top} />，
      <br />
      <FlipPhrase text={bottom} gradient />。
    </h1>
  );
}

function FlipPhrase({
  text,
  gradient,
}: {
  text: string;
  gradient?: boolean;
}) {
  return (
    <span
      key={text}
      className={cn(
        "inline-block animate-flip-in",
        gradient && "gradient-text",
      )}
      style={{ transformOrigin: "center top", backfaceVisibility: "hidden" }}
    >
      {text}
    </span>
  );
}
