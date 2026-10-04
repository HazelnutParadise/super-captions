import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST as captions } from "../app/api/youtube/captions/route.ts";

const MIB = 1024 * 1024;
const CAPTION_MAX_BYTES = 2 * MIB;
const MAIN = "https://www.youtube.com/watch?v=capMain0001";
const realSetTimeout = setTimeout;
const realNow = Date.now;

const SRT = {
  en: "1\n00:00:00,000 --> 00:00:02,000\nfirst cue\n\n2\n00:00:02,500 --> 00:00:04,750\nsecond cue\n",
  "en-orig": "1\n00:00:00,000 --> 00:00:03,000\noriginal asr cue\n\n2\n00:00:03,000 --> 00:00:05,000\noriginal asr cue two\n",
  "zh-Hant": "1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:01,500 --> 00:00:03,000\n第二句\n",
  ko: "1\n00:00:00,000 --> 00:00:02,250\n한국어 자막\n",
};
const RETRY = /再試|重試/;

let dir;
const originalPath = process.env.YT_DLP_PATH;
const originalArgvLog = process.env.YT_DLP_ARGV_LOG;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "captions-tests-"));
  const binary = join(dir, "yt-dlp");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.YT_DLP_ARGV_LOG) fs.appendFileSync(process.env.YT_DLP_ARGV_LOG, JSON.stringify(args) + "\\n");
if (!args.includes('--dump-single-json') || !args.includes('--skip-download')) process.exit(9);
let id = "";
try { id = new URL(args.at(-1)).searchParams.get('v') || ''; } catch {}
const base = { id: id, title: 'CC test clip', duration: 10, is_live: false, live_status: 'not_live' };
const S = (url, extra) => Object.assign({ ext: 'srt', url: url }, extra || {});
const TT = (lang, extra) => 'https://www.youtube.com/api/timedtext?' + new URLSearchParams(Object.assign({ v: id, fmt: 'srt', lang: lang }, extra || {}));
const main = () => Object.assign({}, base, {
  subtitles: { en: [S(TT('en'))], 'zh-Hant': [S(TT('zh-Hant'))] },
  automatic_captions: { en: [
    S(TT('en', { kind: 'asr' })),
    S(TT('en-orig', { kind: 'asr' })),
    S(TT('en', { kind: 'asr', tlang: 'fr' })),
    S(TT('en', { kind: 'asr', tlang: 'zh-Hant' })),
  ] },
});
const filtered = () => Object.assign({}, base, {
  subtitles: {
    en: [
      S('http://www.youtube.com/api/timedtext?lang=en&fmt=srt'),
      S('https://www.youtube.com:8443/api/timedtext?lang=en&fmt=srt'),
      S('https://user:pass@www.youtube.com/api/timedtext?lang=en&fmt=srt'),
      S('https://captions.evil.test/api/timedtext?lang=en&fmt=srt'),
      S('https://www.youtube.com/get_video_info?lang=en&fmt=srt'),
      S(TT('en')),
    ],
    ko: [S('https://youtube.com/api/timedtext?v=' + id + '&lang=ko&fmt=srt')],
    ja: [S(TT('ja'), { ext: 'vtt' })],
  },
  automatic_captions: { en: [S(TT('en', { kind: 'asr', tlang: 'fr' }))] },
});
const simple = () => Object.assign({}, base, { subtitles: { en: [S(TT('en'))] }, automatic_captions: {} });
const fixtures = {
  capMain0001: main,
  capFilter01: filtered,
  capRefuse01: main,
  capEmpty001: simple,
  capHtml0001: simple,
  capNoSrt001: simple,
  capBigCL001: simple,
  capBigStr01: simple,
  capHangSrt1: simple,
  capNoCC0001: () => Object.assign({}, base, { subtitles: {}, automatic_captions: {} }),
};
if (id === 'capDenied01') {
  process.stderr.write('ERROR: Sign in to confirm you are not a bot. YT_DLP_STDERR_MARKER_7c41\\n');
  process.exit(1);
}
if (id === 'capHang0001') setTimeout(() => process.stdout.write(JSON.stringify(base)), 2000);
else process.stdout.write(JSON.stringify(fixtures[id] ? fixtures[id]() : base));
`);
  await chmod(binary, 0o755);
  process.env.YT_DLP_PATH = binary;
});

after(async () => {
  if (originalPath === undefined) delete process.env.YT_DLP_PATH;
  else process.env.YT_DLP_PATH = originalPath;
  if (originalArgvLog === undefined) delete process.env.YT_DLP_ARGV_LOG;
  else process.env.YT_DLP_ARGV_LOG = originalArgvLog;
  if (dir) await rm(dir, { recursive: true, force: true });
});

function post(body, init = {}) {
  return captions(new Request("http://localhost/api/youtube/captions", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init,
  }));
}

/** Records fetch traffic so tests can assert on it and resolve it on demand. */
function intercept(handler) {
  const saved = globalThis.fetch;
  const calls = [];
  const waiters = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const call = { url: String(url), init, aborted: false };
    call.resolve = value => { call.settled = true; resolve(value); };
    call.reject = reason => { call.settled = true; reject(reason); };
    calls.push(call);
    for (const waiter of waiters.splice(0)) waiter();
    const signal = init?.signal;
    const abort = () => {
      call.aborted = true;
      call.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      Promise.resolve(handler(call)).then(value => {
        if (value !== undefined) call.resolve(value);
      }, call.reject);
    } catch (error) { call.reject(error); }
  });
  return {
    calls,
    async waitFor(count, ms = 3000) {
      const deadline = realNow() + ms;
      for (;;) {
        if (calls.length >= count) return;
        if (realNow() > deadline) throw new Error(`caption downloads started: ${calls.length}, wanted ${count}`);
        await new Promise(r => { waiters.push(r); realSetTimeout(r, 10); });
      }
    },
    restore() { globalThis.fetch = saved; },
  };
}

/** Serves the SRT fixture matching each requested timedtext language. */
const serving = () => intercept(call => {
  const lang = new URL(call.url).searchParams.get("lang");
  const body = SRT[lang];
  if (body === undefined) return call.resolve(new Response("unknown language", { status: 404 }));
  return call.resolve(new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
});

/** Never answers on its own; every call stays pending until the test decides. */
const stalling = () => intercept(() => new Promise(() => {}));

/** Virtual clock: only drives guard timers, never paces the test with sleeps. */
function virtualClock(start = 4_000_000) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
  let now = start;
  let sequence = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = ++sequence;
    timers.set(id, { at: now + (Number(ms) || 0), fn, args });
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  Date.now = () => now;
  return {
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        let dueId = 0;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due.at)) { due = timer; dueId = id; }
        if (!due) break;
        timers.delete(dueId);
        now = due.at;
        due.fn(...due.args);
        await new Promise(r => real.setTimeout(r, 5));
      }
      now = target;
      await new Promise(r => real.setTimeout(r, 5));
    },
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      Date.now = real.now;
    },
  };
}

/** Resolves as soon as check() returns something truthy, or fails after ms of real time. */
async function until(check, ms = 3000) {
  const deadline = realNow() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (realNow() > deadline) throw new Error("condition never became observable");
    await new Promise(r => realSetTimeout(r, 5));
  }
}

async function withArgvLog(run) {
  const log = join(dir, "argv.log");
  await writeFile(log, "");
  process.env.YT_DLP_ARGV_LOG = log;
  try { await run(); } finally { delete process.env.YT_DLP_ARGV_LOG; }
  const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return lines.map(line => JSON.parse(line));
}

test("API rejects malformed, oversized and invalid caption requests with 400", async () => {
  const bodies = ["{", "null", "{}", '{"url":"https://127.0.0.1"}',
    '{"url":"https://youtube.com/playlist?list=PL1"}', '{"url":"https://youtu.be/BaW_jenozKc","trackId":"manual"}',
    '{"url":"https://youtu.be/BaW_jenozKc","trackId":"manual:"}', '{"url":"https://youtu.be/BaW_jenozKc","trackId":"captions:en"}',
    '{"url":"https://youtu.be/BaW_jenozKc","trackId":"manual:en:extra"}', '{"url":"https://youtu.be/BaW_jenozKc","trackId":"manual:en/x"}',
    '{"url":"https://youtu.be/BaW_jenozKc","trackId":null}', '{"url":"https://youtu.be/BaW_jenozKc","trackId":7}',
    JSON.stringify({ url: MAIN, padding: "x".repeat(5000) })];
  for (const body of bodies) {
    const response = await post(body);
    assert.equal(response.status, 400, body.slice(0, 70));
    assert.ok((await response.json()).error);
  }
});

test("captions are read as metadata only, with no media format and no subtitle files written", async () => {
  const invocations = await withArgvLog(async () => {
    const fetchStub = serving();
    try { assert.equal((await post({ url: "https://youtu.be/capMain0001" })).status, 200); }
    finally { fetchStub.restore(); }
  });
  assert.equal(invocations.length, 1);
  const argv = invocations[0];
  assert.ok(argv.includes("--dump-single-json"));
  assert.ok(argv.includes("--skip-download"));
  assert.ok(argv.includes("--ignore-no-formats-error"));
  assert.ok(argv.includes("--no-cache-dir"));
  assert.ok(!argv.includes("--format"));
  assert.ok(!argv.some(a => a.startsWith("--write-") || a.startsWith("--output") || a === "-o" || a === "--convert-subs"));
  assert.equal(argv.at(-1), MAIN);
});

test("listing returns manual and YouTube automatic tracks separately, with no download URLs", async () => {
  const fetchStub = serving();
  try {
    const response = await post({ url: "https://youtu.be/capMain0001" });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.ok(!/https?:|timedtext|googlevideo/i.test(raw), raw);
    const { tracks } = JSON.parse(raw);
    assert.ok(Array.isArray(tracks));
    assert.equal(tracks.length, 3);
    for (const track of tracks) {
      assert.deepEqual(Object.keys(track).sort(), ["id", "language", "name", "source"]);
      assert.match(track.id, /^(manual|automatic):[A-Za-z0-9_-]{1,80}$/);
      assert.ok(track.language && typeof track.language === "string");
      assert.ok(track.name && typeof track.name === "string");
      assert.ok(["manual", "automatic"].includes(track.source));
    }
    assert.equal(new Set(tracks.map(t => t.id)).size, 3);
    assert.deepEqual(tracks.filter(t => t.source === "manual").map(t => t.language).sort(), ["en", "zh-Hant"]);
    const automatic = tracks.filter(t => t.source === "automatic");
    assert.equal(automatic.length, 1);
    assert.equal(automatic[0].language, "en-orig");
    assert.equal(automatic[0].id, "automatic:en-orig");
    assert.ok(automatic[0].id.startsWith("automatic:"));
    assert.ok(!tracks.some(t => t.language === "fr"));
    assert.equal(fetchStub.calls.length, 0);
  } finally { fetchStub.restore(); }
});

test("listing keeps only HTTPS YouTube timedtext SRT tracks and drops translated variants", async () => {
  const fetchStub = serving();
  try {
    const response = await post({ url: "https://m.youtube.com/watch?v=capFilter01" });
    assert.equal(response.status, 200);
    const { tracks } = await response.json();
    assert.deepEqual(tracks.map(t => [t.source, t.language]).sort(), [["manual", "en"], ["manual", "ko"]]);

    const bare = await post({ url: "https://youtu.be/capFilter01", trackId: "manual:ko" });
    assert.equal(bare.status, 200);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(new URL(fetchStub.calls[0].url).host, "youtube.com");
    assert.equal(new URL(fetchStub.calls[0].url).protocol, "https:");
    assert.equal(fetchStub.calls[0].init.redirect, "error");
    assert.ok(fetchStub.calls[0].init.signal instanceof AbortSignal);
    assert.equal((await bare.json()).srt, SRT.ko);
  } finally { fetchStub.restore(); }
});

test("videos without any caption track succeed with an empty list", async () => {
  const fetchStub = serving();
  try {
    const response = await post({ url: "https://youtu.be/capNoCC0001" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { tracks: [] });
    assert.equal(fetchStub.calls.length, 0);
  } finally { fetchStub.restore(); }
});

test("unknown caption tracks are reported as 404 without downloading anything", async () => {
  const fetchStub = serving();
  try {
    for (const trackId of ["manual:zz", "automatic:zz", "manual:en-orig"]) {
      const response = await post({ url: "https://youtu.be/capMain0001", trackId });
      assert.equal(response.status, 404, trackId);
      assert.ok((await response.json()).error);
    }
    assert.equal(fetchStub.calls.length, 0);
  } finally { fetchStub.restore(); }
});

test("requesting a track returns its untouched SRT from exactly one download", async () => {
  const fetchStub = serving();
  try {
    const { tracks } = await (await post({ url: "https://youtu.be/capMain0001" })).json();
    const targets = [
      tracks.find(t => t.source === "manual" && t.language === "en"),
      tracks.find(t => t.source === "automatic"),
      tracks.find(t => t.source === "manual" && t.language === "zh-Hant"),
    ];
    for (const target of targets) {
      fetchStub.calls.length = 0;
      const response = await post({ url: "https://youtu.be/capMain0001", trackId: target.id });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(!/https?:|timedtext/i.test(raw), raw);
      const body = JSON.parse(raw);
      assert.deepEqual(body.track, target);
      assert.equal(fetchStub.calls.length, 1);
      assert.equal(body.srt, SRT[new URL(fetchStub.calls[0].url).searchParams.get("lang")]);
      assert.match(body.srt, /^1\n00:00:00,000 --> 00:00:\d\d,\d\d\d\n/);
      assert.equal(fetchStub.calls[0].init.redirect, "error");
    }
    fetchStub.calls.length = 0;
    const deduped = await post({ url: "https://youtu.be/capMain0001", trackId: targets[1].id });
    assert.equal((await deduped.json()).srt, SRT["en-orig"]);
    assert.equal(new URL(fetchStub.calls[0].url).searchParams.get("lang"), "en-orig");
  } finally { fetchStub.restore(); }
});

test("YouTube refusing captions yields 502 with a retry hint and no tool stderr", async () => {
  const fetchStub = intercept(call => call.resolve(new Response("forbidden", { status: 403 })));
  try {
    const response = await post({ url: "https://youtu.be/capRefuse01", trackId: "manual:en" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, RETRY);
  } finally { fetchStub.restore(); }
  const refused = await post({ url: "https://youtu.be/capDenied01" });
  assert.equal(refused.status, 502);
  const { error } = await refused.json();
  assert.match(error, RETRY);
  assert.ok(!/YT_DLP_STDERR_MARKER/.test(error), error);
});

test("empty, HTML and timeline-free caption bodies are rejected with 502", async () => {
  const cases = [
    ["capEmpty001", ""],
    ["capHtml0001", "<!DOCTYPE html><html><body>Sign in to confirm</body></html>"],
    ["capNoSrt001", '{"events":[{"tStartMs":0,"dDurationMs":2000,"segs":[{"utf8":"Hello"}]}]}'],
  ];
  for (const [id, body] of cases) {
    const fetchStub = intercept(call => call.resolve(new Response(body, { headers: { "Content-Type": "text/plain" } })));
    try {
      const response = await post({ url: `https://youtu.be/${id}`, trackId: "manual:en" });
      assert.equal(response.status, 502, id);
      assert.ok((await response.json()).error, id);
    } finally { fetchStub.restore(); }
  }
});

test("caption bodies are capped at 2 MiB by declared length and by streamed bytes", async () => {
  let cancelled = false;
  const declared = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16)); },
    cancel() { cancelled = true; },
  });
  const byLength = intercept(() => new Response(declared, { headers: { "Content-Length": String(CAPTION_MAX_BYTES + 1) } }));
  try {
    const response = await post({ url: "https://youtu.be/capBigCL001", trackId: "manual:en" });
    assert.equal(response.status, 413);
    assert.ok((await response.json()).error);
    assert.equal(cancelled, true);
  } finally { byLength.restore(); }

  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  let stopped = false;
  const oversized = new ReadableStream({
    pull(controller) { if (++pulled > 64) { controller.close(); return; } controller.enqueue(chunk); },
    cancel() { stopped = true; },
  });
  const byStream = intercept(() => new Response(oversized, { headers: { "Content-Type": "text/plain" } }));
  try {
    const response = await post({ url: "https://youtu.be/capBigStr01", trackId: "manual:en" });
    assert.equal(response.status, 413);
    assert.ok((await response.json()).error);
    assert.ok(stopped || pulled * chunk.length <= CAPTION_MAX_BYTES + chunk.length, `kept reading ${pulled} chunks`);
  } finally { byStream.restore(); }
});

test("a truncated caption with a declared length is rejected and can be retried", async () => {
  const fetchStub = intercept(() => new Response(SRT.en, { headers: { "Content-Length": String(Buffer.byteLength(SRT.en) + 64) } }));
  try {
    const response = await post({ url: MAIN, trackId: "manual:en" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, RETRY);
    assert.equal((await post({ url: MAIN })).status, 200);
  } finally { fetchStub.restore(); }
});

test("caption body read errors return a retry message without leaking upstream details", async () => {
  const fetchStub = intercept(() => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error("private signed URL marker"));
  } })));
  try {
    const response = await post({ url: MAIN, trackId: "manual:en" });
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.match(error, RETRY);
    assert.ok(!error.includes("private signed URL marker"));
  } finally { fetchStub.restore(); }
});

test("cancelling a caption request returns 499 and releases the worker slot", async () => {
  const fetchStub = stalling();
  try {
    const controller = new AbortController();
    const pending = post({ url: "https://youtu.be/capMain0001", trackId: "manual:en" }, { signal: controller.signal });
    await fetchStub.waitFor(1);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 499);
    assert.ok((await cancelled.json()).error);
    assert.equal(fetchStub.calls[0].aborted, true);

    const next = post({ url: "https://youtu.be/capMain0001", trackId: "manual:zh-Hant" });
    await fetchStub.waitFor(2);
    fetchStub.calls[1].resolve(new Response(SRT["zh-Hant"]));
    assert.equal((await next).status, 200);
  } finally { fetchStub.restore(); }
});

test("at most two caption requests run per process and slots return after failures", async () => {
  const fetchStub = stalling();
  try {
    const first = post({ url: "https://youtu.be/capMain0001", trackId: "manual:en" });
    const second = post({ url: "https://youtu.be/capMain0001", trackId: "manual:zh-Hant" });
    await fetchStub.waitFor(2);
    const third = await post({ url: "https://youtu.be/capMain0001", trackId: "manual:en" });
    assert.equal(third.status, 429);
    assert.ok((await third.json()).error);

    fetchStub.calls[0].resolve(new Response("upstream down", { status: 500 }));
    fetchStub.calls[1].resolve(new Response("upstream down", { status: 500 }));
    assert.deepEqual([await first, await second].map(r => r.status).sort(), [502, 502]);

    const fourth = post({ url: "https://youtu.be/capMain0001", trackId: "manual:en" });
    await fetchStub.waitFor(3);
    fetchStub.calls[2].resolve(new Response(SRT.en));
    assert.equal((await fourth).status, 200);
  } finally { fetchStub.restore(); }
});

test("a missing yt-dlp binary is reported as 503", async () => {
  const saved = process.env.YT_DLP_PATH;
  process.env.YT_DLP_PATH = join(dir, "no-such-yt-dlp");
  try {
    const response = await post({ url: "https://youtu.be/capMain0001" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /yt-dlp/);
  } finally { process.env.YT_DLP_PATH = saved; }
});

test("a hung metadata read is abandoned once the metadata budget is spent", async () => {
  const log = join(dir, "argv.log");
  await writeFile(log, "");
  process.env.YT_DLP_ARGV_LOG = log;
  const clock = virtualClock();
  try {
    const pending = post({ url: "https://youtu.be/capHang0001" });
    await until(async () => (await readFile(log, "utf8")).trim().length > 0);
    await clock.advance(61_000);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.ok((await response.json()).error);
  } finally {
    clock.restore();
    delete process.env.YT_DLP_ARGV_LOG;
  }
});

test("metadata and caption download share one request budget", async () => {
  const fetchStub = stalling();
  const clock = virtualClock();
  try {
    const pending = post({ url: "https://youtu.be/capHangSrt1", trackId: "manual:en" });
    await fetchStub.waitFor(1);
    await clock.advance(91_000);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.ok((await response.json()).error);
    assert.equal(fetchStub.calls[0].aborted, true);
  } finally {
    clock.restore();
    fetchStub.restore();
  }
});