import { NextResponse } from "next/server";
import type { McpErrorResponse, McpRefusalReason, ToolSettingsResponse } from "@/lib/api-types";
import {
  CODEMODE_INLINE_BUDGET_MAX,
  isCodemodeInlineBudget,
  isCodemodeMode,
  readCodemodeSettings,
  writeCodemodeInlineBudget,
  writeCodemodeMode,
} from "@/lib/codemode-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › MCP saves the global `codemode.mode` and `codemode.inlineBudget`
// here, under the lock pi's SettingsManager takes on the same file. (The tool
// presets are gone: Pi Web sessions always carry every tool, so nothing edits
// the global `defaultTools` any more.) Every refusal carries a `reason` code
// the panel translates, beside the English `error` it shows only as the
// diagnostic of an `internal` failure.

const CHANGES = ["codemodeMode", "codemodeInlineBudget"] as const;

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}

async function readToolSettings(): Promise<ToolSettingsResponse> {
  // One after the other: each takes the file lock, and a reader that finds it
  // held backs off for about a second.
  const { mode: codemodeMode, inlineBudget: codemodeInlineBudget } = await readCodemodeSettings();
  return { codemodeMode, codemodeInlineBudget };
}

export async function GET() {
  try {
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as Record<string, unknown>;
  const keys = Object.keys(changes);
  if (keys.length !== 1 || !(CHANGES as readonly string[]).includes(keys[0])) {
    return refusal(400, "invalid-request", "Send exactly one of codemodeMode or codemodeInlineBudget");
  }

  if ("codemodeMode" in changes) {
    // "on" removes the key: it is pi's default.
    if (!isCodemodeMode(changes.codemodeMode)) {
      return refusal(400, "invalid-request", "codemodeMode must be \"on\" or \"only\"");
    }
    try {
      await writeCodemodeMode(changes.codemodeMode);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  // null removes the key, which gives sessions pi's default.
  const budget = changes.codemodeInlineBudget;
  if (budget !== null && !isCodemodeInlineBudget(budget)) {
    return refusal(400, "invalid-request", `codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`);
  }
  try {
    await writeCodemodeInlineBudget(budget ?? undefined);
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
