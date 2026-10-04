const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: {
    type: "object", required: ["error"], properties: { error: { type: "string" } },
  } } },
});

const captionTrack = {
  type: "object", required: ["id", "language", "name", "source"], properties: {
    id: { type: "string", description: "Track ID returned by listing, e.g. manual:en or automatic:en-orig" },
    language: { type: "string" }, name: { type: "string" }, source: { type: "string", enum: ["manual", "automatic"] },
  },
};

export async function GET() {
  return Response.json({
    openapi: "3.0.3",
    info: { title: "Super Captions API", version: "0.1.0" },
    security: [],
    paths: {
      "/api": { get: { summary: "List supported operations", responses: {
        "200": { description: "Operation overview", content: { "application/json": { schema: { type: "object" } } } },
      } } },
      "/api/openapi": { get: { summary: "Read this OpenAPI document", responses: {
        "200": { description: "OpenAPI JSON", content: { "application/json": { schema: { type: "object" } } } },
      } } },
      "/api/health": { get: { summary: "Service health", responses: {
        "200": { description: "Gateway health result", content: { "application/json": { schema: { type: "object" } } } },
        "502": { description: "Gateway is unreachable", content: { "application/json": { schema: {
          type: "object", required: ["gateway"], properties: { gateway: { type: "string", enum: ["unreachable"] } },
        } } } },
      } } },
      "/api/youtube": { post: {
        summary: "Download one public YouTube video for captioning",
        description: "Accepts watch, youtu.be, Shorts, embed and live links to completed videos. Extra parameters (including playlists) are discarded. Maximum 60 minutes and 500 MiB, up to 720p H.264/AAC MP4. Requires yt-dlp[default], FFmpeg and a JavaScript runtime. One active import per server process, including response transfer. Overall timeout: 10 minutes, metadata probe: 60 seconds. No authentication or cookies. FFmpeg muxes remote video and audio directly to the response without temporary video files. Clients must discard partial downloads if the stream fails. No Content-Length is supplied because the final muxed size is unknown.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        }, example: { url: "https://www.youtube.com/watch?v=BaW_jenozKc" } } } },
        responses: {
          "200": { description: "Downloaded MP4, ready for the same browser captioning pipeline as local upload", headers: {
            "X-Video-Filename": { description: "Percent-encoded UTF-8 MP4 filename", schema: { type: "string" } },
            "Content-Disposition": { description: "Attachment filename", schema: { type: "string" } },
          }, content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
          "400": errorResponse("Malformed JSON or invalid single-video URL"),
          "413": errorResponse("Video exceeds 500 MiB"),
          "422": errorResponse("Live, upcoming, over-length, private, restricted or unavailable video"),
          "429": errorResponse("Another import is active; retry later"),
          "499": errorResponse("Client cancelled the import"),
          "500": errorResponse("Unexpected import failure"),
          "502": errorResponse("YouTube blocked the download, download failed or returned no video"),
          "503": errorResponse("Server downloader or FFmpeg is unavailable"),
          "504": errorResponse("Download timed out"),
        },
      } },
      "/api/youtube/captions": { post: {
        summary: "List YouTube CC tracks or retrieve one as SRT",
        description: "Accepts the same single-video URLs and 60-minute limit as video import. Omit trackId to list original CC and native YouTube automatic captions. Auto-translated tracks are excluded and repeated native automatic tracks are deduplicated. An empty tracks array means no supported CC. Pass a listed trackId to retrieve the unedited SRT with its original timing. No media download, temporary subtitle files, cookies or authentication. Two concurrent CC requests per server process, 90-second overall deadline and 60-second metadata deadline. Request body limited to 4096 bytes; subtitle body limited to 2 MiB. YouTube can refuse CC independently of video import; this does not prevent generated subtitles. Signed upstream URLs stay on the server.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["url"], properties: {
            url: { type: "string", format: "uri", maxLength: 2048 },
            trackId: { type: "string", pattern: "^(manual|automatic):[A-Za-z0-9_-]{1,80}$", description: "Omit to list tracks; use one returned ID to download" },
          },
        }, examples: {
          list: { value: { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" } },
          download: { value: { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", trackId: "manual:en" } },
        } } } },
        responses: {
          "200": { description: "Track list (possibly empty), or one original SRT track", content: { "application/json": { schema: { oneOf: [
            { type: "object", required: ["tracks"], properties: { tracks: { type: "array", items: captionTrack } } },
            { type: "object", required: ["track", "srt"], properties: { track: captionTrack, srt: { type: "string", description: "UTF-8 SRT subtitle text" } } },
          ] } } } },
          "400": errorResponse("Malformed or oversized JSON, invalid video URL or trackId"),
          "404": errorResponse("Selected track is no longer available"),
          "413": errorResponse("Subtitle exceeds 2 MiB"),
          "422": errorResponse("Live, upcoming, over-length, private, restricted or unavailable video"),
          "429": errorResponse("Two CC requests are active; retry later"),
          "499": errorResponse("Client cancelled CC retrieval"),
          "500": errorResponse("Unexpected caption failure"),
          "502": errorResponse("YouTube refused CC, or subtitle response is empty, invalid or interrupted"),
          "503": errorResponse("Server downloader is unavailable"),
          "504": errorResponse("Caption retrieval timed out"),
        },
      } },
      "/api/transcribe": { post: {
        summary: "Transcribe audio and optionally correct subtitles",
        description: "Forwards audio to the configured Whisper Gateway. Returns newline-delimited JSON queue, processing, ping, correcting and final result events. The result event contains status and a JSON body string from the gateway. Inspect the final result.status for transcription errors.",
        parameters: [{ name: "use_llm", in: "query", schema: { type: "boolean", default: false }, description: "Correct typos and caption segmentation using the configured LLM" }],
        requestBody: { required: true, content: { "multipart/form-data": { schema: {
          type: "object", required: ["file"], properties: {
            file: { type: "string", format: "binary", description: "Audio file" },
            model: { type: "string", default: "whisper-1" },
            advanced: { type: "boolean", default: true },
            language: { type: "string", description: "Whisper language code; omit for auto detection" },
            diarize: { type: "boolean", default: true },
            min_speakers: { type: "integer", minimum: 1 },
            max_speakers: { type: "integer", minimum: 1 },
          },
        } } } },
        responses: {
          "200": { description: "NDJSON events ending in a result event", content: { "application/x-ndjson": { schema: {
            type: "object", required: ["type"], properties: {
              type: { type: "string", enum: ["queued", "processing", "ping", "correcting", "result"] },
              ahead: { type: "integer" }, done: { type: "integer" }, total: { type: "integer" },
              status: { type: "integer", description: "Final upstream HTTP status" }, body: { type: "string", description: "Final transcription response encoded as JSON text" },
            },
          } } } },
          "400": errorResponse("Expected multipart audio upload or audio buffering failed"),
          "499": { description: "Client disconnected during upload; empty response" },
          "503": errorResponse("Transcription queue is full; retry after 30 seconds"),
        },
      } },
    },
  });
}
