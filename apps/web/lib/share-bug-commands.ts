// The Web /share and /bug flows, run where the live AgentSession lives: an
// rpc-manager wrapper command calls these with its inner session (ADR 0006:
// the helpers the SDK does not export are loaded from its own dist files).
// Everything they append or serialize goes through the session's own
// SessionManager, so the native session JSONL is the only transcript format.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  loadPiSdkSessionInternals,
  type PiSdkSessionInternals,
  type SdkBugReportBundle,
} from "./pi-sdk-internals";

export type ShareDelivery = "upload" | "download";
export type ShareDestination = "auto" | "radius" | "gist";

export interface ShareCommandInput {
  delivery: ShareDelivery;
  /** Defaults to the persisted sessionShareDestination setting, like the TUI's /share. */
  destination?: ShareDestination;
}

export type ShareCommandResult =
  | { mode: "download"; jsonl: string; fileName: string }
  | { mode: "upload"; via: "radius" | "gist"; url: string; gistUrl?: string };

export interface BugReportCommandInput {
  hint?: string;
  includeSession: boolean;
  includeSummary: boolean;
  delivery: "upload" | "zip";
}

/** The native `BugReportSessionEntryData` recorded in the session JSONL. */
export interface BugReportSessionRecord {
  id: string;
  createdAt: string;
  hint: string | null;
  sessionIncluded: boolean;
  summaryIncluded: boolean;
  delivery: "zip" | "upload";
  path?: string;
}

export type BugReportCommandResult =
  | { mode: "upload"; reportId: string; recorded: BugReportSessionRecord }
  | { mode: "zip"; reportId: string; zipBase64: string; fileName: string; recorded: BugReportSessionRecord };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sessionInternals(): Promise<PiSdkSessionInternals> {
  const result = await loadPiSdkSessionInternals();
  if (!result.ok) throw new Error(`Session share is unavailable: ${result.reason}`);
  return result;
}

/** The exact serialization /share uploads: the branch plus the pi.share trailer. */
export function serializeShareJsonl(
  sdk: PiSdkSessionInternals,
  session: AgentSession,
): string {
  return sdk.serializeSessionBranch(session.sessionManager, (parentId, timestamp) =>
    sdk.createShareTrailingEntries(session, parentId, timestamp));
}

export async function executeShareCommand(
  session: AgentSession,
  input: ShareCommandInput,
): Promise<ShareCommandResult> {
  const sdk = await sessionInternals();
  const jsonl = serializeShareJsonl(sdk, session);
  if (input.delivery === "download") {
    return { mode: "download", jsonl, fileName: `session-${session.sessionId ?? "export"}.jsonl` };
  }

  const destination = input.destination ?? session.settingsManager.getSessionShareDestination();
  if (destination !== "gist") {
    const radius = await tryShareViaRadius(sdk, session, jsonl);
    if (radius !== undefined) return radius;
    if (destination === "radius") {
      throw new Error("Radius authentication is not configured. Run '/login radius' first.");
    }
  }
  return shareViaGist(sdk, session);
}

/**
 * As the TUI's tryShareViaRadius: undefined means "no Radius provider or
 * token" (the auto destination falls through to a gist); an upload attempt
 * that fails throws, so auto never silently retries the same upload as a gist.
 */
async function tryShareViaRadius(
  sdk: PiSdkSessionInternals,
  session: AgentSession,
  jsonl: string,
): Promise<ShareCommandResult | undefined> {
  const provider = session.modelRuntime.getProvider(sdk.RADIUS_PROVIDER_ID);
  if (!provider) return undefined;
  const token = sdk.getAuthCredential(
    await session.modelRuntime.getAuth(sdk.RADIUS_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 }),
  );
  if (!token) return undefined;

  const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
  url.searchParams.set("visibility", "organization");
  url.searchParams.set("title", "neko-pi session");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
      "Content-Length": String(Buffer.byteLength(jsonl)),
    },
    body: jsonl,
  });
  const json = (await response.json().catch(() => null)) as {
    artifact?: { canonical_url: string };
    error?: string;
  } | null;
  if (!response.ok || !json?.artifact) {
    throw new Error(`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`);
  }
  return { mode: "upload", via: "radius", url: json.artifact.canonical_url };
}

/** As the TUI's shareViaGist: gh auth precheck, secret gist, pi.dev viewer URL. */
async function shareViaGist(
  sdk: PiSdkSessionInternals,
  session: AgentSession,
): Promise<ShareCommandResult> {
  try {
    if (spawnSync("gh", ["auth", "status"], { encoding: "utf-8" }).status !== 0) {
      throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub CLI is not logged in")) throw error;
    throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pi-web-share-"));
  try {
    const htmlFile = join(tempDir, "session.html");
    try {
      // The TUI pins its own theme; the Web keeps the session's theme setting.
      await session.exportToHtml(htmlFile);
    } catch (error: unknown) {
      throw new Error(`Failed to export session: ${errorMessage(error)}`);
    }
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc = spawn("gh", ["gist", "create", "--public=false", htmlFile]);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (data) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data) => { stderr += data.toString(); });
      proc.on("error", (error) => resolve({ stdout: "", stderr: errorMessage(error), code: null }));
      proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
    if (result.code !== 0) {
      throw new Error(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
    }
    const gistUrl = result.stdout?.trim();
    const gistId = gistUrl?.split("/").pop();
    if (!gistId) throw new Error("Failed to parse gist ID from gh output");
    return { mode: "upload", via: "gist", url: sdk.getShareViewerUrl(gistId), gistUrl };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors, as the TUI flow does.
    }
  }
}

export async function executeBugReportCommand(
  session: AgentSession,
  input: BugReportCommandInput,
): Promise<BugReportCommandResult> {
  const sdk = await sessionInternals();
  if (input.delivery === "upload" && process.env.PI_OFFLINE) {
    throw new Error("Uploading bug reports requires online mode. Use Export as Zip instead.");
  }

  let summary: string | undefined;
  if (input.includeSummary) {
    summary = await session.summarizeForBugReport({ hint: input.hint, signal: new AbortController().signal });
  }

  const extensions = session.resourceLoader.getExtensions();
  const metadata = sdk.collectBugReportMetadata({
    hint: input.hint,
    sessionId: session.sessionId as string,
    cwd: session.sessionManager.getCwd(),
    includeSession: input.includeSession,
    includeSummary: summary !== undefined,
    messageCount: session.messages.length,
    model: session.model,
    modelRuntime: session.modelRuntime,
    thinkingLevel: session.thinkingLevel,
    extensions: extensions.extensions,
    extensionErrors: extensions.errors,
    globalSettings: session.settingsManager.getGlobalSettings(),
    projectSettings: session.settingsManager.getProjectSettings(),
  });
  const bundle: SdkBugReportBundle = {
    metadata,
    diagnostics: sdk.collectBugReportDiagnostics(session.sessionManager, sdk.readCrashLog()),
    summary,
    ...(input.includeSession ? { sessionJsonl: serializeShareJsonl(sdk, session) } : {}),
  };

  if (input.delivery === "upload") {
    const provider = session.modelRuntime.getProvider(sdk.RADIUS_PROVIDER_ID);
    const token = provider
      ? sdk.getAuthCredential(await session.modelRuntime.getAuth(sdk.RADIUS_PROVIDER_ID, { minOAuthValidityMs: 5 * 60_000 }))
      : undefined;
    const result = await sdk.uploadBugReport(bundle, { token });
    return { mode: "upload", reportId: result.id, recorded: recordBugReportInSession(sdk, session, bundle, { delivery: "upload" }) };
  }

  // The browser cannot write to the process cwd; the archive is streamed back
  // as a download, so no path is recorded (the native entry's `path` is for
  // the file the TUI wrote on disk).
  const tempDir = mkdtempSync(join(tmpdir(), "pi-web-bug-"));
  let zipBase64: string;
  try {
    const archivePath = join(tempDir, sdk.bugReportArchiveFileName(metadata.id));
    await sdk.writeBugReportArchive(bundle, archivePath);
    zipBase64 = readFileSync(archivePath).toString("base64");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const fileName = sdk.bugReportArchiveFileName(metadata.id);
  return {
    mode: "zip",
    reportId: metadata.id,
    zipBase64,
    fileName,
    recorded: recordBugReportInSession(sdk, session, bundle, { delivery: "zip" }),
  };
}

/**
 * Append the same `pi.bug-report` custom entry the TUI writes, through the
 * live session's own SessionManager — the mutable open on the native JSONL.
 */
function recordBugReportInSession(
  sdk: PiSdkSessionInternals,
  session: AgentSession,
  bundle: SdkBugReportBundle,
  delivery: Pick<BugReportSessionRecord, "delivery">,
): BugReportSessionRecord {
  const recorded: BugReportSessionRecord = {
    id: bundle.metadata.id,
    createdAt: bundle.metadata.createdAt,
    hint: bundle.metadata.hint,
    sessionIncluded: bundle.metadata.session.included,
    summaryIncluded: bundle.metadata.session.summaryIncluded,
    ...delivery,
  };
  session.sessionManager.appendCustomEntry(sdk.BUG_REPORT_CUSTOM_ENTRY_TYPE, recorded);
  if (bundle.diagnostics.crashes.length > 0) sdk.clearCrashLog();
  return recorded;
}
