import type { CaptionSegment } from "./types";

export interface ResegmentOptions {
  /** Maximum visual length (rough char count) before a segment gets split. */
  maxChars?: number;
  /** Minimum length each child piece should ideally have — below this we try
   *  not to split so we don't strand tiny "好。" fragments. */
  minChars?: number;
}

const DEFAULT_MAX = 30;
const DEFAULT_MIN = 6;

const STRONG_RE = /([。！？.!?…]+\s*|[\n]+)/;
const MEDIUM_RE = /([；;，,、]+\s*)/;
const SPACE_RE = /(\s+)/;

/**
 * Whisper / WhisperX returns one segment per voice-activity chunk, which can
 * be 60+ characters long for a fast speaker without obvious pauses. That's
 * unreadable as a single caption line. This pass slices any over-long
 * segment at natural punctuation boundaries (sentence end → comma → hard
 * cut) and redistributes the original segment's time window proportionally
 * by character count.
 *
 * Pure function. No external state. Speaker IDs and the original segment's
 * id prefix are preserved so downstream consumers still see a stable lineage.
 */
export function resegment(
  segments: CaptionSegment[],
  options: ResegmentOptions = {}
): CaptionSegment[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const minChars = options.minChars ?? DEFAULT_MIN;

  return segments.flatMap((seg) => splitOne(seg, maxChars, minChars));
}

function splitOne(
  seg: CaptionSegment,
  maxChars: number,
  minChars: number
): CaptionSegment[] {
  const text = seg.text.trim();
  if (text.length <= maxChars) return [{ ...seg, text }];

  const pieces = splitText(text, maxChars, minChars);
  if (pieces.length <= 1) return [{ ...seg, text }];

  const totalLen = pieces.reduce((n, p) => n + p.length, 0);
  if (totalLen === 0) return [{ ...seg, text }];

  const duration = Math.max(0.05, seg.end - seg.start);
  const out: CaptionSegment[] = [];
  let acc = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const start = seg.start + duration * (acc / totalLen);
    acc += piece.length;
    const end =
      i === pieces.length - 1
        ? seg.end
        : seg.start + duration * (acc / totalLen);
    out.push({
      id: `${seg.id}-r${i}`,
      start,
      end: Math.max(end, start + 0.05),
      text: piece,
      speakerId: seg.speakerId,
    });
  }
  return out;
}

export function splitText(text: string, maxChars: number, minChars: number): string[] {
  let pieces = [text];

  // Try progressively weaker boundaries. Each pass only re-splits pieces
  // that are still over the cap; pieces already within budget pass through.
  for (const re of [STRONG_RE, MEDIUM_RE, SPACE_RE]) {
    pieces = pieces.flatMap((p) =>
      p.length <= maxChars ? [p] : greedySplit(p, re, maxChars)
    );
  }

  // Last resort — text with no usable boundary at all. Hard slice it.
  pieces = pieces.flatMap((p) =>
    p.length <= maxChars ? [p] : hardSlice(p, maxChars)
  );

  // If the very last piece is a tiny dangler (e.g. ".") merge it backwards.
  if (pieces.length >= 2 && pieces[pieces.length - 1].trim().length < minChars) {
    const tail = pieces.pop()!;
    pieces[pieces.length - 1] += tail;
  }

  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Split `text` on the given regex (with capture group), then greedily pack
 * the resulting tokens back together so each chunk is as close to maxChars
 * as possible without exceeding it. Delimiter characters stay attached to
 * the preceding token, so "你好，世界。再見。" splits to
 * ["你好，", "世界。", "再見。"] before packing.
 */
function greedySplit(text: string, re: RegExp, maxChars: number): string[] {
  // Build atomic tokens: each token = text up to & including its delimiter.
  const tokens: string[] = [];
  const globalRe = new RegExp(re.source, "g");
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    tokens.push(text.slice(lastIdx, m.index + m[0].length));
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) globalRe.lastIndex++; // safety against zero-width matches
  }
  if (lastIdx < text.length) tokens.push(text.slice(lastIdx));
  if (tokens.length <= 1) return [text];

  // Greedy bin-packing.
  const out: string[] = [];
  let buf = "";
  for (const token of tokens) {
    if (buf.length === 0) {
      buf = token;
    } else if (buf.length + token.length <= maxChars) {
      buf += token;
    } else {
      out.push(buf);
      buf = token;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function hardSlice(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}
