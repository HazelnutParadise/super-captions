/** Allow timestamp rounding and mux padding, capped at three seconds. */
export function matchesYouTubeDuration(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && actual > 0 && Number.isFinite(expected) && expected > 0
    && Math.abs(actual - expected) <= Math.max(1, Math.min(3, expected * 0.001));
}
