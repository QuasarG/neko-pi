import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const markdown = await readFile(join(getPackageDir(), "CHANGELOG.md"), "utf8");
    return Response.json({ markdown }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Changelog unavailable" }, { status: 404 });
  }
}
