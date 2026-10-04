import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeYouTubeUrl, YOUTUBE_MAX_BYTES } from "../lib/youtube-url.ts";
import { downloadYouTubeVideo } from "../lib/youtube-download.ts";
import { importYouTubeVideo } from "../lib/youtube-client.ts";
import { POST } from "../app/api/youtube/route.ts";
import { GET as overview } from "../app/api/route.ts";
import { GET as openapi } from "../app/api/openapi/route.ts";
import { GET as health } from "../app/api/health/route.ts";

const ID = "BaW_jenozKc";
const URL = `https://www.youtube.com/watch?v=${ID}`;
let dir;
const originalPath = process.env.YT_DLP_PATH;
const originalFFmpeg = process.env.FFMPEG_PATH;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "captions-tests-"));
  const binary = join(dir, "yt-dlp");
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args.at(-1);
if (!args.includes('--no-cache-dir') || !args[args.indexOf('--format')+1].includes('height<=720')) process.exit(9);
const id = new URL(url).searchParams.get('v');
if (!url.startsWith('https://www.youtube.com/watch?v=')) process.exit(9);
if (id === 'private0000') { console.error('Private video'); process.exit(1); }
if (id === 'blocked0000') { console.error('Sign in to confirm you’re not a bot'); process.exit(1); }
if (args.includes('--dump-single-json')) {
  console.log(JSON.stringify({ id, title: '測試影片 / 字幕', duration: id === 'long0000000' ? 3601 : id === 'short000000' ? 2939 : 3,
    is_live: id === 'live0000000', live_status: id === 'soon0000000' ? 'is_upcoming' : 'not_live',
    requested_formats: [{filesize: id === 'large000000' ? 524288001 : 40, url:'https://test.googlevideo.com/'+id, vcodec:'avc1.4d401f'},
      {filesize:10, url:'https://test.googlevideo.com/audio-'+id, acodec:'mp4a.40.2'}] }));
}
`);
  await chmod(binary, 0o755);
  process.env.YT_DLP_PATH = binary;
  const ffmpeg = join(dir, "ffmpeg");
  await writeFile(ffmpeg, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.at(-1) !== 'pipe:1' || !args.includes('copy') || !args.includes('+frag_keyframe+empty_moov+default_base_moof')) process.exit(9);
const id = new URL(args[args.indexOf('-i')+1]).pathname.slice(1);
if (id === 'empty000000') process.exit(0);
if (id === 'failed00000') process.exit(1);
process.stdout.write('test-');
setTimeout(() => {if(id==='broken00000') process.exit(1); process.stdout.write('video-bytes'); process.stderr.write('out_time_us='+ (id==='short000000' ? 859100000 : 3000000) +'\\nprogress=end\\n');}, id === 'slow0000000' ? 60000 : 100);
`);
  await chmod(ffmpeg, 0o755);
  process.env.FFMPEG_PATH = ffmpeg;
});
after(async () => {
  if (originalPath === undefined) delete process.env.YT_DLP_PATH;
  else process.env.YT_DLP_PATH = originalPath;
  if (originalFFmpeg === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalFFmpeg;
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("accepts watch, share, mobile, Shorts, embed, live and no-cookie video URLs", () => {
  for (const url of [URL, `${URL}&list=PLtest&t=5`, `https://youtu.be/${ID}?si=test`,
    `https://m.youtube.com/watch?v=${ID}`, `https://youtube.com/shorts/${ID}`,
    `https://youtube.com/embed/${ID}`, `https://youtube.com/live/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`, `http://youtube.com/watch?v=${ID}`]) {
    assert.equal(normalizeYouTubeUrl(` ${url} `), URL);
  }
});
test("rejects non-video URLs, deceptive hosts, credentials, ports and malformed IDs", () => {
  for (const url of [null, 3, "", "youtube.com", "file:///etc/passwd", "https://127.0.0.1/watch?v=" + ID,
    "https://youtube.com.evil.test/watch?v=" + ID, "https://youtube.com@evil.test/watch?v=" + ID,
    "https://name@youtube.com/watch?v=" + ID, "https://youtube.com:8080/watch?v=" + ID,
    "https://youtube.com/playlist?list=PLtest", "https://youtube.com/@channel",
    "https://youtube.com/watch?v=bad", "https://youtu.be/" + ID + "/extra",
    "https://youtube.com/watch?v=" + ID + "&v=other000000"]) {
    assert.throws(() => normalizeYouTubeUrl(url));
  }
});

test("API rejects malformed JSON and URLs before starting a download", async () => {
  for (const body of ["{", "null", '{}', '{"url":"https://127.0.0.1"}']) {
    const response = await POST(new Request("http://localhost/api/youtube", {method: "POST", body}));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
});
test("API streams the first muxed bytes before completion, without temporary videos", async () => {
  const before = (await readdir(tmpdir())).filter(x => x.startsWith("super-captions-youtube-"));
  const response = await POST(new Request("http://localhost/api/youtube", {
    method: "POST", body: JSON.stringify({url: URL})
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-video-duration"), "3");
  assert.equal(decodeURIComponent(response.headers.get("x-video-filename")), "測試影片 _ 字幕.mp4");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "test-");
  const rest = await reader.read();
  assert.equal(new TextDecoder().decode(rest.value), "video-bytes");
  assert.equal((await reader.read()).done, true);
  assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith("super-captions-youtube-")), before);
});
test("API exposes actionable upstream and dependency errors without stderr", async () => {
  for (const [id, status] of [["private0000", 422], ["blocked0000", 502], ["long0000000", 422],
    ["live0000000", 422], ["soon0000000", 422], ["large000000", 413], ["empty000000", 502],
    ["failed00000", 502]]) {
    const response = await POST(new Request("http://localhost/api/youtube", {
      method: "POST", body: JSON.stringify({url: `https://youtu.be/${id}`})
    }));
    assert.equal(response.status, status, id);
    assert.ok((await response.json()).error);
  }
  const saved = process.env.YT_DLP_PATH;
  process.env.YT_DLP_PATH = join(dir, "missing");
  try {
    const response = await POST(new Request("http://localhost/api/youtube", {
      method: "POST", body: JSON.stringify({url: URL})
    }));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /yt-dlp/);
  } finally { process.env.YT_DLP_PATH = saved; }
  const savedFFmpeg = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = join(dir, "missing-ffmpeg");
  try {
    const response = await POST(new Request("http://localhost/api/youtube", {
      method: "POST", body: JSON.stringify({url: URL})
    }));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /FFmpeg/);
  } finally { process.env.FFMPEG_PATH = savedFFmpeg; }
});
test("cancelled streams terminate the converter and release the import slot", async () => {
  const before = (await readdir(tmpdir())).filter(x => x.startsWith("super-captions-youtube-"));
  const controller = new AbortController();
  const video = await downloadYouTubeVideo("https://www.youtube.com/watch?v=slow0000000", controller.signal);
  const reader = video.stream.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort();
  await assert.rejects(pending, /取消/);
  await video.cleanup();
  assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith("super-captions-youtube-")), before);
  const next = await downloadYouTubeVideo(URL, new AbortController().signal);
  await next.stream.cancel();
  await next.cleanup();
});
test("mid-stream upstream failure does not masquerade as a complete video", async () => {
  const response = await POST(new Request("http://localhost/api/youtube", {
    method:"POST", body:JSON.stringify({url:"https://youtu.be/broken00000"})
  }));
  assert.equal(response.status, 200);
  await assert.rejects(() => response.text());
});
test("concurrent import is rejected until the first response is consumed or cancelled", async () => {
  const request = () => new Request("http://localhost/api/youtube", {method:"POST", body:JSON.stringify({url: URL})});
  const first = await POST(request());
  assert.equal(first.status, 200);
  const second = await POST(request());
  assert.equal(second.status, 429);
  await first.body.cancel();
  const third = await POST(request());
  assert.equal(third.status, 200);
  await third.body.cancel();
});

test("client creates the same File input as local upload and reports progress", async () => {
  const saved = globalThis.fetch;
  const savedDocument = globalThis.document;
  globalThis.document = {createElement: () => ({
    duration: 3, pause() {}, removeAttribute() {}, load() {},
    set src(value) {queueMicrotask(() => this.onloadedmetadata?.());},
  })};
  const progress = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/youtube");
    assert.equal(JSON.parse(init.body).url, URL);
    return new Response("video", {headers: {"Content-Type":"video/mp4", "Content-Length":"5",
      "X-Video-Filename":encodeURIComponent("測試.mp4"), "X-Video-Duration":"3"}});
  };
  try {
    const file = await importYouTubeVideo(`https://youtu.be/${ID}`, p => progress.push(p));
    assert.equal(file.type, "video/mp4");
    assert.equal(file.name, "測試.mp4");
    assert.equal(await file.text(), "video");
    assert.equal(progress.at(-1), 100);
  } finally {globalThis.fetch = saved; globalThis.document = savedDocument;}
});
test("client handles API error, invalid/truncated/oversized and empty responses", async () => {
  const saved = globalThis.fetch;
  try {
    for (const response of [new Response(JSON.stringify({error:"影片無法取得"}), {status:422}),
      new Response("error", {headers:{"Content-Type":"text/html"}}),
      new Response("", {headers:{"Content-Type":"video/mp4"}}),
      new Response("video", {headers:{"Content-Type":"video/mp4", "Content-Length":"10"}}),
      new Response("video", {headers:{"Content-Type":"video/mp4", "Content-Length":String(YOUTUBE_MAX_BYTES+1)}})]) {
      globalThis.fetch = async () => response;
      await assert.rejects(() => importYouTubeVideo(URL));
    }
  } finally {globalThis.fetch = saved;}
});


test("API overview lists every documented operation and health schema matches its errors", async () => {
  const listing = await (await overview()).json();
  const spec = await (await openapi()).json();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      assert.ok(listing.endpoints.some(e => e.path === path && e.method === method.toUpperCase()), path);
    }
  }
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => {throw new Error("unreachable")};
    const response = await health();
    const body = await response.json();
    const schema = spec.paths["/api/health"].get.responses[response.status].content["application/json"].schema;
    for (const required of schema.required) assert.ok(required in body, required);
  } finally {globalThis.fetch = saved;}
});


test("exit-zero shortened media is rejected and the import slot can be reused", async () => {
  const video = await downloadYouTubeVideo("https://youtu.be/short000000", new AbortController().signal);
  try {
    await assert.rejects(() => new Response(video.stream).arrayBuffer(), /不完整/);
  } finally { await video.cleanup(); }
  const next = await downloadYouTubeVideo(URL, new AbortController().signal);
  await new Response(next.stream).arrayBuffer();
});

test("client rejects clean EOF with a playable short prefix before reporting complete", async () => {
  const savedFetch = globalThis.fetch;
  const savedDocument = globalThis.document;
  const progress = [];
  globalThis.document = {createElement: () => ({
    duration: 859.1, pause() {}, removeAttribute() {}, load() {},
    set src(value) {queueMicrotask(() => this.onloadedmetadata?.());},
  })};
  globalThis.fetch = async () => new Response("prefix", {headers: {
    "Content-Type": "video/mp4", "X-Video-Duration": "2939",
  }});
  try {
    await assert.rejects(() => importYouTubeVideo(URL, p => progress.push(p)), /不完整/);
    assert.equal(progress.includes(100), false);
  } finally {globalThis.fetch = savedFetch; globalThis.document = savedDocument;}
});
