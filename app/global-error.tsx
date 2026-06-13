"use client";

import { useEffect } from "react";

function isChunkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("ChunkLoadError") ||
         msg.includes("Loading chunk") ||
         msg.includes("Loading CSS chunk") ||
         (err instanceof Error && err.name === "ChunkLoadError");
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error:", error);
    if (isChunkError(error)) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="zh-Hant">
      <body className="flex min-h-screen items-center justify-center bg-black p-6">
        <div className="max-w-md text-center">
          <h1 className="mb-2 text-2xl font-bold text-white">載入失敗</h1>
          <p className="mb-6 text-neutral-400">
            應用程式區塊載入失敗，可能是因為版本已更新。
          </p>
          <button
            onClick={() => reset()}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white transition-colors hover:bg-purple-700"
          >
            重新載入
          </button>
        </div>
      </body>
    </html>
  );
}
