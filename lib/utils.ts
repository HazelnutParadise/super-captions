import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(Math.floor(s))}.${pad(ms, 3)}`;
  }
  return `${pad(m)}:${pad(Math.floor(s))}.${pad(ms, 3)}`;
}

export function formatShort(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
