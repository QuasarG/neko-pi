import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { GET } from "./route.ts";

test("changelog route serves the changelog from the installed pi package", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const { markdown } = await response.json();
  assert.equal(markdown, await readFile(join(getPackageDir(), "CHANGELOG.md"), "utf8"));
});
