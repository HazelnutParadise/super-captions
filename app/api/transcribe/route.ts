import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5000";

/** Hard cap on how many requests can sit waiting for the gateway slot
 *  before we start rejecting upfront with 503. Keeps memory bounded so an
 *  abusive client can't queue thousands of multi-GB uploads at once. */
const MAX_QUEUE_DEPTH = 50;

/**
 * Streaming proxy from the browser to 榛果繽紛樂's Speech Gateway with two
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
 *      20 s while waiting (both in queue and during upstream processing).
 *      The final line `{"type":"result",status,body}` carries the gateway
 *      response. CF never sees the connection go idle.
 *
 * We also never call req.formData() — that buffers the entire upload
 * (potentially hundreds of MB for multi-hour videos) into memory. Once
 * we get our slot, the request body is piped straight into the upstream
 * fetch with its original multipart boundary intact.
 */

// ---- in-process mutex --------------------------------------------------

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];
  /** Monotonic counter of completed acquires. Combined with a per-handler
   *  snapshot at enqueue time it lets us compute "how many jobs finished
   *  since I joined" without having to track positions inside the waiters
   *  array. */
  private completedCount = 0;

  /** Number waiting + the one currently running (if any). */
  get pending(): number {
    return this.waiters.length + (this.locked ? 1 : 0);
  }
  /** Number ahead of the next acquirer right now. */
  get waiting(): number {
    return this.waiters.length;
  }
  get completed(): number {
    return this.completedCount;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted before acquire");
    }
    if (this.locked) {
      let myResolver!: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          myResolver = resolve;
          this.waiters.push(resolve);
          if (signal) {
            const onAbort = () => {
              // Pull ourselves out of waiters[] so a later release()
              // doesn't hand the lock to a dead client and deadlock the
              // queue.
              const idx = this.waiters.indexOf(myResolver);
              if (idx !== -1) this.waiters.splice(idx, 1);
              reject(signal.reason ?? new Error("aborted while queued"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } catch (e) {
        // If we lost the race between abort and resolve (resolver got
        // shifted off and called just as abort fired), waiters[] no longer
        // has us but the promise already resolved — meaning the lock IS
        // ours. Release it immediately so the next waiter can take it.
        if (this.waiters.indexOf(myResolver) === -1) {
          // Resolver was consumed → we got the slot. Need to "decline" it.
          // Acquire path will set locked below; instead, mark locked then
          // immediately release so completedCount stays sane.
          this.locked = true;
          this.completedCount++;
          this.locked = false;
          const next = this.waiters.shift();
          if (next) next();
        }
        throw e;
      }
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.completedCount++;
      this.locked = false;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

const gatewayLock = new Mutex();

// ---- handler -----------------------------------------------------------

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const contentType = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length");
  const pendingBefore = gatewayLock.pending;
  console.log(
    `[transcribe] POST received ct=${contentType} cl=${contentLength ?? "n/a"} hasBody=${!!req.body} queue=${pendingBefore}`
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

  const reqBody = req.body;

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
  });

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
            body: reqBody,
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
        emit({ type: "result", status: upstream.status, body });
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
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
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
