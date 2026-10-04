import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importYouTubeVideo } from "../lib/youtube-client.ts";
import { POST } from "../app/api/youtube/route.ts";

// Issue #3 regression: simulate a short mux that exits 0, and clean browser EOF.
// The deployed run did not establish why the original download stopped early.
const SOURCE_SECONDS = 2939;                                             // 48:59, inside the 60 minute cap
const CUT_SECONDS = 859.1;                                               // what a silently cut mux reports
const TOLERANCE = Math.max(1, Math.min(3, SOURCE_SECONDS * 0.001));     // 2.939s for this source
const WITHIN_SECONDS = SOURCE_SECONDS - 2.8;                             // 2936.2s, still the same video
const BEYOND_SECONDS = SOURCE_SECONDS - 9;                               // 2930s, a shorter video
const BODY = "mp4-bytes";
const HEADER_SECONDS = String(SOURCE_SECONDS);
const us = (seconds) => Math.round(seconds * 1e6);

let dir;
let argvLog;
const originalYtDlp = process.env.YT_DLP_PATH;
const originalFfmpeg = process.env.FFMPEG_PATH;
const originalArgvLog = process.env.FFMPEG_ARGV_LOG;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "captions-completeness-"));
  const downloader = join(dir, "yt-dlp");
  await writeFile(downloader, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--dump-single-json') || !args.includes('--skip-download')) process.exit(9);
const id = new URL(args.at(-1)).searchParams.get('v') || '';
console.log(JSON.stringify({ id, title: '完整性測試影片', duration: ${SOURCE_SECONDS}, is_live: false,
  live_status: 'not_live', requested_formats: [
    {filesize: 4096, url: 'https://test.googlevideo.com/v-' + id, vcodec: 'avc1.4d401f'},
    {filesize: 1024, url: 'https://test.googlevideo.com/a-' + id, acodec: 'mp4a.40.2'}] }));
`);
  await chmod(downloader, 0o755);
  process.env.YT_DLP_PATH = downloader;
  const converter = join(dir, "ffmpeg");
  await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FFMPEG_ARGV_LOG) fs.appendFileSync(process.env.FFMPEG_ARGV_LOG, JSON.stringify(args) + "\\n");
if (args.at(-1) !== 'pipe:1' || !args.includes('copy')) process.exit(9);
const id = new URL(args[args.indexOf('-i') + 1]).pathname.slice(3);
// Emit the same progress protocol as FFmpeg when requested.
const reportsProgress = args[args.indexOf('-progress') + 1] === 'pipe:2';
const block = (outTime, isEnd) => [
  'frame=' + Math.round((outTime || 0) / 1e6) * 24,
  'fps=24.0',
  'bitrate=2500kbits/s',
  outTime === null ? null : 'out_time_us=' + outTime,
  'speed=52.3x',
  'progress=' + (isEnd ? 'end' : 'continue'),
].filter(Boolean).join('\\n') + '\\n';
const PLANS = {
  complete000: {steps: [300000000, 1500000000, ${us(SOURCE_SECONDS)}], ends: true},
  tolerance00: {steps: [${us(SOURCE_SECONDS)}, ${us(WITHIN_SECONDS)}], ends: true},
  beyond00000: {steps: [300000000, ${us(BEYOND_SECONDS)}], ends: true},
  truncat0000:  {steps: [${us(CUT_SECONDS)}], ends: false},
  noend000000:  {steps: [300000000, ${us(SOURCE_SECONDS)}], ends: false},
  nodur000000:  {steps: [null], ends: true},
};
const plan = PLANS[id];
if (!plan) process.exit(9);
process.stdout.write('mp4-');
setTimeout(() => {
  try {
    process.stdout.write('bytes');
    if (reportsProgress) plan.steps.forEach((outTime, index) =>
      process.stderr.write(block(outTime, index === plan.steps.length - 1 && plan.ends)));
  } catch {}
}, 5);
`);
  await chmod(converter, 0o755);
  process.env.FFMPEG_PATH = converter;
  argvLog = join(dir, "ffmpeg-argv.log");
  await writeFile(argvLog, "");
  process.env.FFMPEG_ARGV_LOG = argvLog;
});
after(async () => {
  if (originalYtDlp === undefined) delete process.env.YT_DLP_PATH;
  else process.env.YT_DLP_PATH = originalYtDlp;
  if (originalFfmpeg === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalFfmpeg;
  if (originalArgvLog === undefined) delete process.env.FFMPEG_ARGV_LOG;
  else process.env.FFMPEG_ARGV_LOG = originalArgvLog;
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Headers are already flushed, so a short mux has to fail the body, not the status. */
async function startImport(id) {
  const response = await POST(new Request("http://localhost/api/youtube", {
    method: "POST", body: JSON.stringify({ url: `https://youtu.be/${id}` }),
  }));
  assert.equal(response.status, 200, `${id}: headers are sent before the mux finishes`);
  return response;
}

async function readBody(response) {
  try { return { text: await response.text() }; } catch (error) { return { error }; }
}

/** Asserts the stream rejects, and always drains it so the import slot cannot leak. */
async function assertStreamFails(id, label) {
  const response = await startImport(id);
  const result = await readBody(response);
  await response.body?.cancel().catch(() => {});
  assert.ok(result.error, `${label} (${id})`);
  assert.ok(result.error instanceof Error, `${label} (${id}) must fail with an Error`);
  return result.error;
}

async function lastFfmpegArgs() {
  const log = (await readFile(argvLog, "utf8")).trim();
  return log ? JSON.parse(log.split("\n").at(-1)) : null;
}

test("API announces the source duration and finishes only on a complete FFmpeg progress run", async () => {
  const response = await startImport("complete000");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const announced = Number(response.headers.get("x-video-duration"));
  assert.ok(Number.isFinite(announced) && announced > 0 && announced <= 3600, "X-Video-Duration must be a finite source duration");
  assert.equal(announced, SOURCE_SECONDS);
  assert.deepEqual(await readBody(response), { text: BODY });
  const args = await lastFfmpegArgs();
  const index = args?.indexOf("-progress") ?? -1;
  assert.ok(index >= 0 && args[index + 1] === "pipe:2", "FFmpeg must be asked for -progress pipe:2");
});

test("progress inside the 2.939s tolerance still completes the response", async () => {
  const response = await startImport("tolerance00");
  assert.equal(Number(response.headers.get("x-video-duration")), SOURCE_SECONDS);
  assert.deepEqual(await readBody(response), { text: BODY });
});

test("progress beyond the tolerance is rejected instead of silently truncating", async () => {
  assert.ok(Math.abs(BEYOND_SECONDS - SOURCE_SECONDS) > TOLERANCE);
  await assertStreamFails("beyond00000", `final progress ${BEYOND_SECONDS}s exceeds the ${TOLERANCE}s tolerance`);
});

test("exit 0 with only 859.1s of progress and no progress=end fails the stream and frees the import slot", async () => {
  await assertStreamFails("truncat0000", `exit 0 after only ${CUT_SECONDS}s of ${SOURCE_SECONDS}s must not look complete`);
  const retried = await startImport("complete000");
  assert.equal(Number(retried.headers.get("x-video-duration")), SOURCE_SECONDS);
  assert.deepEqual(await readBody(retried), { text: BODY });
});

test("progress that never ends or never reports out_time_us cannot pass as a finished video", async () => {
  await assertStreamFails("noend000000", "a full-length run without progress=end is an unfinished mux");
  await assertStreamFails("nodur000000", "progress=end without out_time_us has no length to verify");
});

/* HTML video metadata stand-in: only the events importYouTubeVideo needs, no browser suite. */
class FakeVideo {
  constructor(events, scenario) {
    this.events = events;
    this.scenario = scenario;
    this.seeks = [];
    this.duration = scenario.duration ?? 0;
    this._src = "";
    this._scheduled = false;
  }
  get src() { return this._src; }
  set src(value) { this._src = value; this.load(); }
  set currentTime(value) {
    this.seeks.push(value);
    // Browsers only resolve an unknown duration once playback seeks far ahead.
    if (!Number.isFinite(this.duration) && value > 0 && this.scenario.seekDuration !== undefined) {
      this.duration = this.scenario.seekDuration;
      setTimeout(() => {
        this.events.push("durationchange");
        this.dispatch("durationchange");
        this.dispatch("seeked");
      }, 0);
    }
  }
  load() {
    if (!this._src || this._scheduled) return;
    this._scheduled = true;
    setTimeout(() => {
      this._scheduled = false;
      if (this.scenario.error) {
        this.events.push("video:error");
        this.dispatch("error");
        return;
      }
      this.duration = this.scenario.duration ?? 0;
      this.events.push("metadata");
      this.dispatch("loadedmetadata");
    }, this.scenario.metadataDelay ?? 0);
  }
  removeAttribute(name) { if (name === "src") this._src = ""; }
  dispatch(type) {
    const event = { type, target: this };
    const inline = this["on" + type];
    if (typeof inline === "function") inline.call(this, event);
  }
}

function installDom(scenario) {
  const dom = { events: [], videos: [], live: new Set(), revoked: new Set() };
  const savedDocument = globalThis.document;
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  let counter = 0;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "video", "the File metadata must be read with a video element");
      const video = new FakeVideo(dom.events, scenario);
      dom.videos.push(video);
      return video;
    },
  };
  URL.createObjectURL = () => {
    const url = `blob:captions-completeness/${++counter}`;
    dom.live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => { dom.live.delete(url); dom.revoked.add(url); };
  dom.restore = () => {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  };
  return dom;
}

/** Serves one streaming response and records the progress the client reports. */
async function withClient(scenario, options, run) {
  if (typeof options === "function") { run = options; options = {}; }
  const { body = BODY, contentLength, hang = false } = options ?? {};
  const header = options && "header" in options ? options.header : HEADER_SECONDS;
  const dom = installDom(scenario);
  const savedFetch = globalThis.fetch;
  const progress = [];
  let pulled;
  const wasPulled = new Promise((resolve) => { pulled = resolve; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/youtube");
    const signal = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        const stop = () => controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (hang) { if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true }); }
        else controller.close();
      },
      pull() { pulled(); },
    });
    const headers = { "Content-Type": "video/mp4", "X-Video-Filename": encodeURIComponent("完整性測試.mp4") };
    if (header !== undefined) headers["X-Video-Duration"] = header;
    if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
    return new Response(stream, { headers });
  };
  try {
    return await run({ ...dom, progress, wasPulled });
  } finally {
    globalThis.fetch = savedFetch;
    dom.restore();
  }
}

const waitFor = async (ready, label) => {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const assertRejected = (promise) => assert.rejects(promise, /影片|取消|aborted/i);

test("a complete stream reports 100 only after the File metadata matches the source", async () => {
  await withClient({ duration: SOURCE_SECONDS }, async (client) => {
    const file = await importYouTubeVideo("https://youtu.be/complete000", (percent) => {
      client.progress.push(percent);
      client.events.push(`progress:${percent}`);
    });
    assert.ok(file instanceof File);
    assert.equal(file.type, "video/mp4");
    assert.equal(file.name, "完整性測試.mp4");
    assert.equal(await file.text(), BODY);
    assert.deepEqual(client.progress, [100]);
    assert.ok(client.events.indexOf("metadata") < client.events.indexOf("progress:100"),
      "100% may only be reported after the metadata has been verified");
    assert.deepEqual([...client.live], []);
    assert.equal(client.revoked.size, 1);
  });
});

test("a stream without Content-Length that ends at 859.1s of metadata is rejected", async () => {
  await withClient({ duration: CUT_SECONDS }, async (client) => {
    await assertRejected(importYouTubeVideo("https://youtu.be/truncat0000", (percent) => client.progress.push(percent)));
    assert.ok(!client.progress.includes(100), "a truncated video must never report 100%");
    assert.deepEqual([...client.live], []);
  });
});

test("missing, non-numeric and out-of-range X-Video-Duration headers are all rejected", async () => {
  for (const header of [undefined, "", "abc", "0", "-5", "NaN", "Infinity", "3601"]) {
    await withClient({ duration: SOURCE_SECONDS }, { header }, async (client) => {
      await assertRejected(importYouTubeVideo("https://youtu.be/complete000"));
      assert.deepEqual([...client.live], [], `header ${String(header)}`);
    });
  }
});

test("an unknown metadata duration is settled by seeking a large time until durationchange", async () => {
  await withClient({ duration: Infinity, seekDuration: SOURCE_SECONDS }, async (client) => {
    const file = await importYouTubeVideo("https://youtu.be/complete000", (percent) => client.progress.push(percent));
    assert.equal(await file.text(), BODY);
    assert.deepEqual(client.progress, [100]);
    assert.equal(client.videos.length, 1);
    assert.ok(client.videos[0].seeks.length > 0, "an infinite duration needs a large seek");
    assert.ok(Math.max(...client.videos[0].seeks) > 1e6, `seeked to ${client.videos[0].seeks.at(-1)}`);
    assert.ok(client.events.includes("durationchange"));
    assert.deepEqual([...client.live], []);
  });
});

test("video.onerror rejects the import and still revokes the object URL", async () => {
  await withClient({ error: true }, async (client) => {
    await assertRejected(importYouTubeVideo("https://youtu.be/complete000", (percent) => client.progress.push(percent)));
    assert.ok(client.events.includes("video:error"));
    assert.ok(!client.progress.includes(100));
    assert.deepEqual([...client.live], []);
    assert.equal(client.revoked.size, 1);
  });
});

test("cancelling while the body is still streaming rejects the import", async () => {
  await withClient({ duration: SOURCE_SECONDS }, { contentLength: BODY.length, hang: true }, async (client) => {
    const controller = new AbortController();
    const pending = importYouTubeVideo("https://youtu.be/complete000", (percent) => client.progress.push(percent), controller.signal);
    await client.wasPulled;
    controller.abort();
    await assertRejected(pending);
    assert.ok(!client.progress.includes(100));
    assert.deepEqual([...client.live], []);
  });
});

test("cancelling while the metadata is pending rejects the import and revokes the object URL", async () => {
  await withClient({ duration: SOURCE_SECONDS, metadataDelay: 100 }, async (client) => {
    const controller = new AbortController();
    const pending = importYouTubeVideo("https://youtu.be/complete000", (percent) => client.progress.push(percent), controller.signal);
    await waitFor(() => client.events.includes("metadata") === false && client.videos.length === 1, "the metadata read");
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assertRejected(pending);
    assert.ok(!client.progress.includes(100));
    assert.deepEqual([...client.live], []);
    assert.equal(client.revoked.size, 1);
  });
});
