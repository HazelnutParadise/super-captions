import { NextResponse } from "next/server";

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5000";

export async function GET() {
  try {
    const r = await fetch(`${GATEWAY}/healthz`, { cache: "no-store" });
    return NextResponse.json({ gateway: r.ok ? "ok" : "down", status: r.status });
  } catch (e) {
    return NextResponse.json({ gateway: "unreachable" }, { status: 502 });
  }
}
