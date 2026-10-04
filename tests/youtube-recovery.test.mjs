import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST } from "../app/api/youtube/route.ts";

const ffmpeg = process.env.TEST_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.TEST_FFPROBE_PATH || "ffprobe";
const available = spawnSync(ffmpeg, ["-hide_banner", "-h", "protocol=http"]).stdout?.includes("reconnect_max_retries")
  && spawnSync(ffprobe, ["-version"]).status === 0;
if (process.env.REQUIRE_YOUTUBE_TRANSPORT_TESTS === "1" && !available) throw new Error("FFmpeg HTTP reconnect support and ffprobe are required");
const nativeTest = (name, fn) => test(name, { skip: !available && "FFmpeg HTTP reconnect support or ffprobe unavailable", timeout: 30_000 }, fn);
let dir, server, port, baseline;
const media = new Map(), requests = [], sockets = new Set(), diagnostics = [];
const saved = { yt: process.env.YT_DLP_PATH, ff: process.env.FFMPEG_PATH, info: console.info };
let onResume;

before(async () => {
  if (!available) return;
  dir = await mkdtemp(join(tmpdir(), "captions-range-"));
  for (const [name, seconds, audio] of [["video.mp4", 12, false], ["audio.m4a", 12, true], ["short-video.mp4", 6, false], ["short-audio.m4a", 6, true]]) {
    const path = join(dir, name);
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      audio ? "sine=frequency=440:sample_rate=48000" : "testsrc2=size=160x90:rate=10",
      "-t", String(seconds), ...(audio ? ["-c:a", "aac", "-vn"] : ["-c:v", "libx264", "-threads", "1", "-g", "20", "-pix_fmt", "yuv420p", "-an"]),
      "-movflags", "+faststart", path], { timeout: 10_000 });
    assert.equal(result.status, 0, "synthetic fixture generation must succeed");
    media.set(name, await Bun.file(path).bytes());
  }
  server = createServer((req, res) => {
    const [id, filename] = new URL(req.url, "http://localhost").pathname.slice(1).split("/");
    let data = media.get(filename);
    if (id === "videocut000" && filename === "video.mp4") data = media.get("short-video.mp4");
    if (id === "audiocut000" && filename === "audio.m4a") data = media.get("short-audio.m4a");
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0);
    const count = requests.filter(x => x.id === id && x.filename === filename).length + 1;
    requests.push({ id, filename, start, count });
    if (id === "refuse40300" || id === "retry503000" && filename === "video.mp4" && count === 1) {
      res.writeHead(id === "refuse40300" ? 403 : 503, { "Retry-After": "10000" }); res.end("unavailable"); return;
    }
    assert.ok(data, "fixture must exist");
    res.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
      "Content-Length": data.length - start, "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}` });
    let end = data.length;
    if (filename === "video.mp4" && ["videobreak0", "noresume000", "cancel00000"].includes(id) && count === 1 || filename === "audio.m4a" && id === "audiobreak0" && count === 1) end = Math.floor(data.length / 2);
    if (id === "noresume000" && filename === "video.mp4" && count > 1) end = start;
    if (id === "manybreak00" && filename === "video.mp4") end = Math.min(data.length, start + 4000);
    if (id === "cancel00000" && filename === "video.mp4" && count > 1) {
      res.flushHeaders(); onResume?.(); return;
    }
    res.end(data.subarray(start, end));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const yt = join(dir, "yt-dlp"), adapter = join(dir, "ffmpeg");
  await writeFile(yt, `#!/usr/bin/env node
const id=new URL(process.argv.at(-1)).searchParams.get('v');
console.log(JSON.stringify({title:'fixture',duration:12,requested_formats:[
 {url:'https://test.googlevideo.com/'+id+'/video.mp4?secret=sentinel-signed-token'},
 {url:'https://test.googlevideo.com/'+id+'/audio.m4a?secret=sentinel-signed-token'}]}));
`);
  await writeFile(adapter, `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const args=process.argv.slice(2).map(a=>a.startsWith('https://test.googlevideo.com/')?a.replace('https://test.googlevideo.com','http://127.0.0.1:${port}'):a);
const child=spawn(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
`);
  await chmod(yt, 0o755); await chmod(adapter, 0o755);
  process.env.YT_DLP_PATH = yt; process.env.FFMPEG_PATH = adapter;
  console.info = record => diagnostics.push(JSON.parse(record));
});

after(async () => {
  console.info = saved.info;
  if (saved.yt === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = saved.yt;
  if (saved.ff === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved.ff;
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function download(id, signal) {
  const response = await POST(new Request("http://localhost/api/youtube", { method: "POST",
    body: JSON.stringify({ url: "https://youtu.be/" + id }), signal }));
  const importId = response.headers.get("x-youtube-import-id");
  assert.match(importId || "", /^[a-f0-9-]{36}$/);
  let bytes, error;
  try { bytes = new Uint8Array(await response.arrayBuffer()); } catch (e) { error = e; }
  const record = diagnostics.find(x => x.importId === importId);
  assert.ok(record, "error/success must be observable only after cleanup and diagnostic recording");
  assert.equal(diagnostics.filter(x => x.importId === importId).length, 1);
  assert.equal(record.event, "youtube-import-server");
  assert.equal(record.expectedDuration, 12);
  assert.match(record.ffmpegVersion || "", /^[\w.+~:-]+$/);
  assert.ok(!JSON.stringify(record).includes("sentinel-signed-token"));
  assert.ok(!JSON.stringify(record).includes("http"));
  return { response, bytes, error, record };
}

nativeTest("real FFmpeg completes a full import with both tracks and safe diagnostic correlation", async () => {
  const result = await download("baseline000");
  assert.equal(result.response.status, 200); assert.equal(result.error, undefined);
  assert.equal(result.record.outcome, "complete"); assert.equal(result.record.ffmpegExit, 0);
  assert.equal(result.record.bytesSent, result.bytes.length);
  baseline = result.bytes;
  const path = join(dir, "recovered.mp4"); await writeFile(path, baseline);
  const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path], { timeout: 5000 });
  assert.equal(probe.status, 0);
  const streams = JSON.parse(probe.stdout).streams;
  for (const kind of ["video", "audio"]) assert.ok(Math.abs(Number(streams.find(x => x.codec_type === kind)?.duration) - 12) < 0.5);
});

for (const [id, track] of [["videobreak0", "video.mp4"], ["audiobreak0", "audio.m4a"]]) {
  nativeTest(`real FFmpeg resumes an interrupted ${track} with byte-identical output`, async () => {
    const result = await download(id);
    assert.equal(result.error, undefined); assert.equal(result.record.outcome, "complete");
    assert.ok(requests.some(x => x.id === id && x.filename === track && x.start > 0), "must resume at a nonzero byte offset");
    assert.deepEqual(result.bytes, baseline); assert.equal(result.record.reconnects, 1);
  });
}

nativeTest("HTTP 503 recovers promptly despite a long Retry-After; 403 is not retried", async () => {
  const result = await download("retry503000");
  assert.equal(result.error, undefined); assert.deepEqual(result.bytes, baseline);
  assert.ok(result.record.elapsedMs < 10_000);
  const denied = await download("refuse40300");
  assert.equal(denied.response.status, 502);
  assert.equal(denied.record.outcome, "upstream_error");
  assert.equal(requests.filter(x => x.id === "refuse40300" && x.filename === "video.mp4").length, 1);
});

nativeTest("no-progress disconnects terminate and release the import slot", async () => {
  const result = await download("noresume000");
  assert.ok(result.error || !result.response.ok); assert.notEqual(result.record.outcome, "complete");
  assert.ok(requests.filter(x => x.id === "noresume000" && x.filename === "video.mp4").length <= 3);
  assert.equal((await download("baseline000")).record.outcome, "complete");
});

nativeTest("repeated partial progress cannot reset the whole-import reconnect budget", async () => {
  const result = await download("manybreak00");
  assert.ok(result.error || !result.response.ok); assert.equal(result.record.outcome, "retry_exhausted");
  assert.equal(result.record.reconnects, 5);
  assert.ok(requests.filter(x => x.id === "manybreak00" && x.filename === "video.mp4").length <= 7);
  assert.equal((await download("baseline000")).record.outcome, "complete");
});

for (const id of ["videocut000", "audiocut000"]) {
  nativeTest(`independently shortened ${id} fails despite a normal FFmpeg exit`, async () => {
    const result = await download(id);
    assert.ok(result.error); assert.equal(result.record.ffmpegExit, 0);
    assert.equal(result.record.outcome, "incomplete");
  });
}

nativeTest("abort during recovery kills the process and releases the import slot", async () => {
  const controller = new AbortController();
  const resumed = new Promise(resolve => { onResume = resolve; });
  const pending = download("cancel00000", controller.signal);
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await resumed; controller.abort();
    const result = await pending;
    assert.ok(result.error || !result.response.ok); assert.equal(result.record.outcome, "cancelled");
    assert.equal((await download("baseline000")).record.outcome, "complete");
  } finally { clearTimeout(timer); onResume = undefined; }
});
