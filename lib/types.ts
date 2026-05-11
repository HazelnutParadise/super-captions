export interface CaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  speakerId: string | null;
}

export interface SpeakerStyle {
  id: string;
  name: string;
  color: string; // accent / preview chip color
  fill: string; // text fill color
  stroke: string; // text border / stroke color
  strokeWidth: number; // px
  background: string; // background color behind text (with alpha)
  fontFamily: string;
  fontSize: number; // px, relative to 720p
  fontWeight: number;
  paddingX: number;
  paddingY: number;
  borderRadius: number;
}

export const DEFAULT_FONTS = [
  "Inter, system-ui, sans-serif",
  "'Noto Sans TC', sans-serif",
  "'JetBrains Mono', monospace",
  "Georgia, serif",
  "'Comic Sans MS', cursive",
];

export const SPEAKER_PRESET_COLORS = [
  "#a855f7",
  "#22d3ee",
  "#f472b6",
  "#facc15",
  "#34d399",
  "#fb923c",
  "#60a5fa",
  "#f87171",
];

export function makeDefaultSpeaker(
  id: string,
  index: number,
  name?: string
): SpeakerStyle {
  const color = SPEAKER_PRESET_COLORS[index % SPEAKER_PRESET_COLORS.length];
  return {
    id,
    name: name ?? `講者 ${index + 1}`,
    color,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 3,
    background: "rgba(0,0,0,0.55)",
    fontFamily: DEFAULT_FONTS[0],
    fontSize: 42,
    fontWeight: 700,
    paddingX: 18,
    paddingY: 10,
    borderRadius: 8,
  };
}
