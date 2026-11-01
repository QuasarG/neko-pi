// /bug for the Web. GET gives the consent dialog the gateway host its
// delivery recap names and whether PI_OFFLINE forbids uploading. POST replays
// the dialog's consent choices as the wrapper's "bug_report" command: native
// metadata/diagnostics (plus optional model summary) built against the live
// agent session, then upload or a zip download, with the pi.bug-report entry
// appended to the same native session JSONL.

import { jsonResponse } from "@/lib/json-response";
import { loadPiSdkSessionInternals } from "@/lib/pi-sdk-internals";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

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
    return jsonResponse(req, { error: `Bug reports are unavailable: ${internals.reason}` }, { status: 503 });
  }
  return jsonResponse(req, {
    gatewayHost: new URL(internals.getRadiusGatewayUrl()).host,
    offline: Boolean(process.env.PI_OFFLINE),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) return jsonResponse(req, { error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null) as {
    hint?: unknown;
    includeSession?: unknown;
    includeSummary?: unknown;
    delivery?: unknown;
  } | null;
  if (
    !body
    || typeof body.includeSession !== "boolean"
    || typeof body.includeSummary !== "boolean"
    || (body.delivery !== "upload" && body.delivery !== "zip")
  ) {
    return jsonResponse(req, {
      error: 'body must carry boolean includeSession/includeSummary and delivery "upload" or "zip"',
    }, { status: 400 });
  }
  if (body.hint !== undefined && typeof body.hint !== "string") {
    return jsonResponse(req, { error: "hint must be a string" }, { status: 400 });
  }

  const filePath = await resolveSessionPath(id);
  if (!filePath) return jsonResponse(req, { error: "Session not found" }, { status: 404 });

  try {
    const existing = getRpcSession(id);
    const wrapper = existing?.isAlive()
      ? existing
      : (await startRpcSession(id, filePath, undefined)).session;
    const result = await wrapper.send({
      type: "bug_report",
      ...(typeof body.hint === "string" && body.hint.trim() ? { hint: body.hint.trim() } : {}),
      includeSession: body.includeSession,
      includeSummary: body.includeSummary,
      delivery: body.delivery,
    }) as {
      mode: "upload" | "zip";
      reportId: string;
      zipBase64?: string;
      fileName?: string;
    };
    if (result.mode === "upload") {
      return jsonResponse(req, { reportId: result.reportId });
    }
    const archive = Buffer.from(result.zipBase64 ?? "", "base64");
    const fileName = (result.fileName ?? `pi-bug-report-${result.reportId}.zip`).replace(/[^\w.-]/g, "_");
    return new Response(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(archive.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonResponse(req, { error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
