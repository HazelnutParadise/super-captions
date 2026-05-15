import type { CaptionSegment, SpeakerStyle } from "./types";

/**
 * Draw a single caption (with the styling of its assigned speaker, or a
 * default style) onto a canvas, positioned near the bottom of the frame.
 */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  style: SpeakerStyle
) {
  if (!text.trim()) return;

  // Scale off the *short* side (≈720p reference), not height — otherwise a
  // tall portrait clip inflates captions to landscape-height proportions.
  // Portrait gets an extra trim since its narrow width makes equally-scaled
  // text feel oversized.
  const isPortrait = height > width;
  const scale = (Math.min(width, height) / 720) * (isPortrait ? 0.82 : 1);
  const fontSize = Math.round(style.fontSize * scale);
  const paddingX = Math.round(style.paddingX * scale);
  const paddingY = Math.round(style.paddingY * scale);
  const radius = Math.round(style.borderRadius * scale);
  const strokeWidth = Math.max(0, style.strokeWidth * scale);

  ctx.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Word-wrap so caption never exceeds ~85% of frame width.
  const maxWidth = width * 0.85;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = Math.round(fontSize * 1.25);
  const totalHeight =
    lines.length * lineHeight + paddingY * 2 - (lineHeight - fontSize);

  const baseX = width / 2;
  let baseY = Math.round(height * 0.9 - totalHeight / 2);

  // Keep the whole block (background pills + text) inside the frame: push it
  // up if it spills past the bottom safe area, then pin to the top if a very
  // tall block still won't fit (so the start of the caption stays on-screen).
  const safeTop = Math.round(height * 0.03);
  const safeBottom = Math.round(height * 0.05);
  const blockBottom = baseY + lines.length * lineHeight - fontSize;
  if (blockBottom > height - safeBottom) {
    baseY -= blockBottom - (height - safeBottom);
  }
  const blockTop = baseY - fontSize - paddingY / 2;
  if (blockTop < safeTop) {
    baseY += safeTop - blockTop;
  }

  // Draw background pill per-line so it hugs the text shape.
  ctx.save();
  ctx.fillStyle = style.background;
  for (let i = 0; i < lines.length; i++) {
    const lineWidth = ctx.measureText(lines[i]).width;
    const x = baseX - lineWidth / 2 - paddingX;
    const y = baseY + i * lineHeight - fontSize - paddingY / 2;
    const w = lineWidth + paddingX * 2;
    const h = lineHeight + paddingY * 0.5;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
  }
  ctx.restore();

  // Stroke (text border)
  if (strokeWidth > 0) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = strokeWidth;
    for (let i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i], baseX, baseY + i * lineHeight);
    }
    ctx.restore();
  }

  // Fill (text body)
  ctx.save();
  ctx.fillStyle = style.fill;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], baseX, baseY + i * lineHeight);
  }
  ctx.restore();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  // For CJK we can break on any char; for Latin we break on spaces.
  const isCJK = /[　-鿿가-힯]/.test(text);
  if (isCJK) {
    const chars = Array.from(text);
    const lines: string[] = [];
    let cur = "";
    for (const ch of chars) {
      const test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? cur + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function currentSegment(
  segments: CaptionSegment[],
  time: number
): CaptionSegment | null {
  for (const s of segments) {
    if (time >= s.start && time <= s.end) return s;
  }
  return null;
}
