import { NextRequest, NextResponse } from "next/server";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink, stat, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Mutex } from "@/lib/mutex";
import { correctAndResegmentWithLLM } from "@/lib/llm-subtitle";

const TMP_PREFIX = "transcribe-";
const TMP_SUFFIX = ".bin";

/**
 * On module load, sweep any tmp files left behind by a previous BFF crash.
 * Normal request paths clean up after themselves via the abort listener +
 * finally + cancel, but a hard crash (OOM, SIGKILL) gives the JS runtime
 * no chance to unlink — without this sweep the host's /tmp grows unbounded
 * across container restarts.
 */
let _sweepStarted = false;
function sweepStaleTmpFiles() {
  if (_sweepStarted) return;
  _sweepStarted = true;
  void (async () => {
    try {
      const dir = tmpdir();
      const names = await readdir(dir);
      const now = Date.now();
      let cleaned = 0;
      for (const name of names) {
        if (!name.startsWith(TMP_PREFIX) || !name.endsWith(TMP_SUFFIX)) continue;
        const path = join(dir, name);
        try {
          const s = await stat(path);
          // Anything older than 1 h is from a previous run (or a stuck
          // request that's already failed every retry).
          if (now - s.mtimeMs > 60 * 60 * 1000) {
            await unlink(path);
            cleaned++;
          }
        } catch {
          /* file vanished concurrently */
        }
      }
      if (cleaned > 0) {
        console.log(`[transcribe] startup sweep removed ${cleaned} stale tmp file(s)`);
      }
    } catch (e) {
      console.warn("[transcribe] startup sweep failed:", e);
    }
  })();
}
sweepStaleTmpFiles();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5000";

/** Hard cap on how many requests can sit waiting for the gateway slot
 *  before we start rejecting upfront with 503. Each queued request keeps a
 *  tmp file on disk, so this bounds disk usage rather than memory. */
const MAX_QUEUE_DEPTH = 50;

/**
 * Streaming proxy from the browser to 榛果繽紛樂's Speech Gateway with three
 * cross-cutting concerns layered on top of a plain fetch passthrough:
 *
 *   1. Concurrency limit — the gateway runs Whisper end-to-end on one
 *      audio stream at a time; sending it three concurrent multi-hour
 *      jobs will OOM it. We serialise upstream calls through a process-
 *      wide mutex so at most ONE request talks to the gateway at any
 *      moment. Anything else queues.
 *
 *   2. Cloudflare 524 avoidance — Whisper takes minutes on long inputs
 *      and CF cuts idle connections at 100 s. We respond with 200 + an
 *      NDJSON stream immediately and emit `{"type":"ping",...}` every
 *      5 s while waiting (both in queue and during upstream processing).
 *      The final line `{"type":"result",status,body}` carries the gateway
 *      response. CF never sees the connection go idle.
 *
 *   3. Cloudflare 502-while-queued avoidance — if we hold the request body
 *      undrained during queue wait, CF eventually gives up on the stalled
 *      upload and 502s the client. So we drain the incoming multipart
 *      stream to a tmp file on disk FIRST (lets the client→CF→origin
 *      upload complete fast), THEN take our place in the queue. When the
 *      slot is ours we stream the tmp file back out to upstream.
 */

// ---- in-process mutex --------------------------------------------------

const gatewayLock = new Mutex();

// ---- handler -----------------------------------------------------------

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const contentType = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length");
  const pendingBefore = gatewayLock.pending;
  // Per-request toggle for LLM correction. Read from query string so we
  // don't have to parse & re-encode the multipart body just to find one flag.
  const useLLM = req.nextUrl.searchParams.get("use_llm") === "true";
  console.log(
    `[transcribe] POST received ct=${contentType} cl=${contentLength ?? "n/a"} hasBody=${!!req.body} queue=${pendingBefore} useLLM=${useLLM}`
  );

  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }
  if (gatewayLock.pending >= MAX_QUEUE_DEPTH) {
    console.warn(
      `[transcribe] queue full (${gatewayLock.pending}/${MAX_QUEUE_DEPTH}); rejecting with 503`
    );
    return NextResponse.json(
      { error: "Gateway busy, please retry later", queue: gatewayLock.pending },
      { status: 503, headers: { "retry-after": "30" } }
    );
  }

  const upstreamHeaders: Record<string, string> = {
    "content-type": contentType,
  };
  if (contentLength) upstreamHeaders["content-length"] = contentLength;

  // Set up the tmp-file cleanup hook BEFORE we register the abort
  // listener — the listener references it.
  const tmpPath = join(tmpdir(), `${TMP_PREFIX}${randomUUID()}${TMP_SUFFIX}`);
  let tmpCleanedUp = false;
  const cleanupTmp = async () => {
    if (tmpCleanedUp) return;
    tmpCleanedUp = true;
    try {
      await unlink(tmpPath);
    } catch {
      /* already gone */
    }
  };

  // Abort plumbing: when the browser drops the NDJSON connection (closed
  // tab, dev-server reload, user retry), kill any in-flight upstream fetch
  // and release the mutex slot eagerly. Otherwise a disconnected client
  // would keep the gateway tied up running a transcription nobody's
  // waiting for, blocking everyone behind in the queue.
  const upstreamAbort = new AbortController();
  let clientDisconnected = false;
  req.signal.addEventListener("abort", () => {
    clientDisconnected = true;
    upstreamAbort.abort();
    void cleanupTmp();
  });

  // Drain the multipart upload to a tmp file BEFORE entering the queue.
  // If we left req.body undrained while waiting for a slot, the client
  // upload TCP socket would stall (no backpressure consumer at the BFF),
  // and Cloudflare 502s the request after ~90s of stalled upload. With
  // the file on disk the client's upload completes quickly; the disk
  // copy waits for the gateway slot at our leisure.
  try {
    const bufferStart = Date.now();
    await pipeline(
      // Readable.fromWeb's typings are stricter than the runtime — both
      // Node fetch and Bun fetch accept this conversion at runtime.
      Readable.fromWeb(req.body as never),
      createWriteStream(tmpPath)
    );
    let bufferedBytes: number | null = null;
    try {
      bufferedBytes = (await stat(tmpPath)).size;
    } catch {
      /* size best-effort */
    }
    console.log(
      `[transcribe] body buffered to disk (${bufferedBytes ?? "?"} bytes) in ${Date.now() - bufferStart}ms`
    );
  } catch (e) {
    await cleanupTmp();
    if (clientDisconnected) {
      console.log("[transcribe] client disconnected during upload buffering");
      return new NextResponse(null, { status: 499 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[transcribe] failed to buffer upload to disk:", msg);
    return NextResponse.json(
      { error: "Upload buffering failed", detail: msg },
      { status: 400 }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (obj: Record<string, unknown>) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* controller may be closed */
        }
      };

      // Snapshot the queue state at enqueue time so we can report a live
      // "ahead = (initial ahead) - (jobs that finished since)" number to
      // the client without inspecting the waiters array.
      const initialAhead = gatewayLock.pending;
      const completedAtEnqueue = gatewayLock.completed;
      let acquired = false;
      const computeAhead = () => {
        if (acquired) return 0;
        const finished = gatewayLock.completed - completedAtEnqueue;
        return Math.max(0, initialAhead - finished);
      };

      const heartbeat = setInterval(() => {
        if (clientDisconnected) return;
        if (acquired) {
          emit({ type: "ping", t: Date.now() - t0 });
        } else {
          emit({ type: "queued", t: Date.now() - t0, ahead: computeAhead() });
        }
      }, 5_000);

      let release: (() => void) | null = null;
      try {
        if (initialAhead > 0) {
          emit({ type: "queued", t: 0, ahead: initialAhead });
          console.log(
            `[transcribe] queued behind ${initialAhead} request(s); waiting for slot`
          );
        }

        // Acquire the gateway slot. We pass req.signal so that if the
        // client disconnects while still queued, Mutex.acquire pulls our
        // resolver out of waiters[] and rejects — no dead-slot deadlock.
        try {
          release = await gatewayLock.acquire(req.signal);
        } catch (e) {
          if (clientDisconnected) {
            console.log(
              "[transcribe] client disconnected while queued; abandoned slot intent"
            );
            return;
          }
          throw e;
        }

        if (clientDisconnected) {
          // Race: we won the slot the same tick the client aborted. Release
          // immediately so the next waiter can take it.
          release();
          release = null;
          console.log("[transcribe] client gone right after acquire; released slot");
          return;
        }

        acquired = true;
        const waitedMs = Date.now() - t0;
        emit({ type: "processing", t: waitedMs });
        if (initialAhead > 0) {
          console.log(
            `[transcribe] acquired gateway slot after ${waitedMs}ms in queue`
          );
        }
        console.log(`[transcribe] forwarding to ${GATEWAY}/v1/audio/transcriptions`);

        const upstream = await fetch(
          `${GATEWAY}/v1/audio/transcriptions`,
          {
            method: "POST",
            headers: upstreamHeaders,
            // Stream from the buffered tmp file (filled while we were
            // waiting in the queue). Each acquire creates a fresh
            // ReadableStream-wrapped fs.ReadStream — fetch will drain it.
            body: Readable.toWeb(
              createReadStream(tmpPath)
            ) as ReadableStream<Uint8Array>,
            signal: upstreamAbort.signal,
            // Required by the fetch spec when body is a ReadableStream.
            // @ts-expect-error — duplex is not yet in the lib.dom typings.
            duplex: "half",
          }
        );
        const body = await upstream.text();
        console.log(
          `[transcribe] upstream status=${upstream.status} bytes=${body.length} after ${Date.now() - t0}ms (waited ${waitedMs}ms in queue)`
        );

        let finalBody = body;
        if (upstream.status === 200 && useLLM) {
          try {
            const data = JSON.parse(body);
            if (Array.isArray(data.segments) && data.segments.length > 0) {
              emit({ type: "correcting", t: Date.now() - t0, done: 0, total: 0 });
              console.log("[transcribe] Starting LLM correcting and resegmenting...");
              const corrected = await correctAndResegmentWithLLM(
                data.segments,
                (done, total) => {
                  emit({ type: "correcting", t: Date.now() - t0, done, total });
                }
              );
              data.segments = corrected;
              data.llmProcessed = true;
              finalBody = JSON.stringify(data);
              console.log("[transcribe] LLM correcting and resegmenting completed.");
            }
          } catch (e) {
            console.error("[transcribe] LLM correction failed:", e);
            throw new Error(`LLM 修正與分段失敗：${e instanceof Error ? e.message : String(e)}`);
          }
        }

        emit({ type: "result", status: upstream.status, body: finalBody });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (clientDisconnected) {
          console.log(
            `[transcribe] aborted after client disconnect: ${msg}`
          );
        } else {
          console.error("[transcribe] upstream error:", msg);
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({ error: msg }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (release) release();
        // Always remove the buffered upload, success or fail.
        await cleanupTmp();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // Browser dropped the response stream — make sure the tmp file
      // doesn't linger. The finally block above also runs, this is just
      // a belt for cancellation between start() and first read.
      void cleanupTmp();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
