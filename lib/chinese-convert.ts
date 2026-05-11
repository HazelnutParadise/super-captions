"use client";

export type ChineseScript = "traditional" | "simplified";

type Converter = (s: string) => string;

let _converterPromise: Promise<{
  toTraditional: Converter;
  toSimplified: Converter;
}> | null = null;

async function getConverters() {
  if (!_converterPromise) {
    _converterPromise = import("opencc-js").then((mod) => {
      const Converter =
        (mod as unknown as { Converter: typeof import("opencc-js").Converter })
          .Converter ??
        (mod as unknown as { default: { Converter: typeof import("opencc-js").Converter } })
          .default.Converter;
      return {
        // Simplified (China) → Traditional with Taiwan word swaps
        // (e.g. 软件→軟體, 网络→網路).
        toTraditional: Converter({ from: "cn", to: "twp" }),
        // Traditional (Taiwan) → Simplified (China).
        toSimplified: Converter({ from: "tw", to: "cn" }),
      };
    });
  }
  return _converterPromise;
}

/**
 * Convert a snippet of Chinese text to the requested script. The OpenCC
 * dictionary is loaded lazily on first use so we don't add ~1 MB to the
 * initial bundle.
 */
export async function convertChinese(
  text: string,
  target: ChineseScript
): Promise<string> {
  if (!text) return text;
  const { toTraditional, toSimplified } = await getConverters();
  return target === "traditional" ? toTraditional(text) : toSimplified(text);
}
