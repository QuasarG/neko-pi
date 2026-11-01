import { constants, existsSync } from "node:fs";
import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, cacheSessionPath, invalidateSessionListCache } from "@/lib/session-reader";
import { isApiRequestAllowed } from "@/lib/request-security";
import { jsonResponse } from "@/lib/json-response";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return jsonResponse(req, { error: "Untrusted API request" }, { status: 403 });
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) return jsonResponse(req, { error: "Content-Type must be multipart/form-data" }, { status: 415 });
  const { id } = await params;
  const activePath = await resolveSessionPath(id);
  if (!activePath) return jsonResponse(req, { error: "Session not found" }, { status: 404 });

  const form = await req.formData();
  const upload = form.get("session");
  if (!(upload instanceof File) || !upload.name.toLowerCase().endsWith(".jsonl")) {
    return jsonResponse(req, { error: "Choose a .jsonl session file" }, { status: 400 });
  }
  if (upload.size === 0 || upload.size > MAX_IMPORT_BYTES) {
    return jsonResponse(req, { error: "Session file must be between 1 byte and 50 MB" }, { status: 413 });
  }

  const active = SessionManager.open(activePath);
  const sessionDir = active.getSessionDir();
  await mkdir(sessionDir, { recursive: true });
  const stagedPath = join(sessionDir, `.import-${randomUUID()}.tmp`);
  try {
    await writeFile(stagedPath, Buffer.from(await upload.arrayBuffer()), { flag: "wx" });
    const imported = SessionManager.open(stagedPath, sessionDir);
    if (!imported.getSessionId()) return jsonResponse(req, { error: "Invalid session file" }, { status: 400 });
    if (!existsSync(imported.getCwd())) {
      return jsonResponse(req, { error: "The session working directory is missing", requiresCwd: true }, { status: 409 });
    }
    const existing = await resolveSessionPath(imported.getSessionId());
    if (existing) return jsonResponse(req, { error: "A session with this ID already exists" }, { status: 409 });

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    let destination = join(sessionDir, `${stamp}_${imported.getSessionId()}.jsonl`);
    for (let suffix = 1; await fileExists(destination); suffix++) destination = join(sessionDir, `${stamp}_${imported.getSessionId()}-${suffix}.jsonl`);
    await copyFile(stagedPath, destination, constants.COPYFILE_EXCL);
    cacheSessionPath(imported.getSessionId(), destination);
    invalidateSessionListCache();
    return jsonResponse(req, { sessionId: imported.getSessionId(), cwd: imported.getCwd() });
  } catch (error) {
    return jsonResponse(req, { error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
