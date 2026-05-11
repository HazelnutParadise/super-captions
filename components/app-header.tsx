"use client";
import Link from "next/link";
import { Sparkles, Captions } from "lucide-react";

export function AppHeader() {
  return (
    <header className="container mx-auto flex items-center justify-between px-6 py-6">
      <Link href="/" className="flex items-center gap-3">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 shadow-lg shadow-fuchsia-500/30">
          <Captions className="h-7 w-7 text-white" strokeWidth={2} />
          <span className="absolute -right-1 -top-1 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-fuchsia-500" />
          </span>
        </div>
        <div className="leading-tight">
          <div className="text-2xl font-extrabold tracking-tight">
            <span className="gradient-text">Super Captions</span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Whisper · ffmpeg.wasm · Next.js
          </div>
        </div>
      </Link>

      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 rounded-full border border-border/80 bg-card/60 px-3 py-1.5 backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
          On-device audio · zero video upload
        </span>
      </nav>
    </header>
  );
}
