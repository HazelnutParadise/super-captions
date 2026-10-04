export async function GET() {
  return Response.json({
    title: "Super Captions API",
    documentation: "/api/openapi",
    endpoints: [
      { method: "GET", path: "/api", description: "Operation overview", documentation: "/api/openapi#/paths/~1api" },
      { method: "GET", path: "/api/openapi", description: "OpenAPI document", documentation: "/api/openapi#/paths/~1api~1openapi" },
      { method: "GET", path: "/api/health", description: "Service health", documentation: "/api/openapi#/paths/~1api~1health" },
      { method: "POST", path: "/api/transcribe", description: "Transcribe multipart audio as NDJSON events", documentation: "/api/openapi#/paths/~1api~1transcribe" },
      { method: "POST", path: "/api/youtube", description: "Stream one public YouTube video as an MP4 (60 min, 500 MiB, up to 720p)", documentation: "/api/openapi#/paths/~1api~1youtube" },
    ],
  });
}
