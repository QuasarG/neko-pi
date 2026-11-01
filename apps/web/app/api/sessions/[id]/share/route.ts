// /share for the Web. GET reads the persisted destination the TUI's /share
// uses, so the consent dialog shows what would leave the machine and where.
// POST runs the native serialization against the live agent session (the
// wrapper's "share" command) and either uploads per that destination or
// returns the exact same JSONL as a no-network download.

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { jsonResponse } from "@/lib/json-response";
import { loadPiSdkSessionInternals } from "@/lib/pi-sdk-internals";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) return jsonResponse(req, { error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const filePath = await resolveSessionPath(id);
  if (!filePath) return jsonResponse(req, { error: "Session not found" }, { status: 404 });

  const internals = await loadPiSdkSessionInternals();
  if (!internals.ok) {
    return jsonResponse(req, { error: `Session share is unavailable: ${internals.reason}` }, { status: 503 });
  }
  const cwd = readSessionHeader(filePath)?.cwd ?? process.cwd();
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
  return jsonResponse(req, {
    destination: settings.getSessionShareDestination(),
    gatewayHost: new URL(internals.getRadiusGatewayUrl()).host,
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) return jsonResponse(req, { error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null) as { delivery?: unknown } | null;
  if (!body || (body.delivery !== "upload" && body.delivery !== "download")) {
    return jsonResponse(req, { error: 'delivery must be "upload" or "download"' }, { status: 400 });
  }

  const filePath = await resolveSessionPath(id);
  if (!filePath) return jsonResponse(req, { error: "Session not found" }, { status: 404 });

  try {
    const existing = getRpcSession(id);
    const wrapper = existing?.isAlive()
      ? existing
      : (await startRpcSession(id, filePath, undefined)).session;
    const result = await wrapper.send({ type: "share", delivery: body.delivery }) as {
      mode: "download" | "upload";
      jsonl?: string;
      fileName?: string;
      url?: string;
      via?: "radius" | "gist";
      gistUrl?: string;
    };
    if (result.mode === "download") {
      return new Response(result.jsonl ?? "", {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": contentDisposition(result.fileName ?? `session-${id}.jsonl`),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return jsonResponse(req, {
      url: result.url,
      via: result.via,
      ...(result.gistUrl ? { gistUrl: result.gistUrl } : {}),
    });
  } catch (error) {
    return jsonResponse(req, { error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.jsonl";
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
