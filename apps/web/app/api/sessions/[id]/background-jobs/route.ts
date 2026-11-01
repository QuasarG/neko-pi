import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { listBackgroundJobs } from "@earendil-works/pi-coding-agent/runtime";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  readUtf8FileWithinLimit,
  resolveBackgroundSpoolPath,
} from "@/lib/bash-output";
import { resolveSessionPath } from "@/lib/session-reader";

export interface BackgroundJobClientView {
  id: string;
  kind: "bash" | "subagent";
  label: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  exitCode?: number | null;
  /** The spool file carrying the full output, when one exists (bash jobs). */
  outputFile?: string;
}

// GET /api/sessions/[id]/background-jobs
//   The session's background jobs from the process-wide registry — the data the
//   composer badge counts and the top-right status card's work rows render.
// GET /api/sessions/[id]/background-jobs?jobId=<id>
//   One bash job's live output snapshot, read from the job's spool file — the
//   1s poll the right-panel detail tab rides (catalog A.4). `download=1`
//   returns the spool as an attachment instead.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  const download = url.searchParams.get("download") === "1";

  // The registry only holds jobs this process registered; a session that was
  // never alive here (a stale id) is still "known" only if its file exists,
  // matching how the other session routes distinguish 404 from empty.
  const jobs = listBackgroundJobs(id);
  if (jobs.length === 0 && !await resolveSessionPath(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!jobId) {
    const view: BackgroundJobClientView[] = jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      startedAt: job.startedAt,
      status: job.status,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.outputFile ? { outputFile: job.outputFile } : {}),
    }));
    return NextResponse.json({ success: true, data: { jobs: view } });
  }

  const job = jobs.find((entry) => entry.id === jobId);
  if (!job || job.kind !== "bash" || !job.outputFile) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const spoolPath = resolveBackgroundSpoolPath(job.outputFile, tmpdir());
  if (!spoolPath) {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }

  try {
    const result = await readUtf8FileWithinLimit(spoolPath);
    if (result.tooLarge) {
      return NextResponse.json({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413 });
    }
    if (download) {
      return new Response(result.content, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="background-job.log"',
          "Cache-Control": "no-store",
        },
      });
    }
    // The job row in the registry is the status authority: a finished job's
    // spool simply stops growing, and the poller stops on this status.
    return NextResponse.json({
      success: true,
      data: {
        id: job.id,
        status: job.status,
        output: result.content,
        outputFile: job.outputFile,
        exitCode: job.exitCode ?? null,
      },
    });
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}
