import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getMemoryChannel } from "../../src/core/memory/channel.ts";
import { resolveProjectIdentity } from "../../src/core/runtime/identity.ts";
import { getRuntimeState } from "../../src/core/runtime/state-db.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const factories = [{ name: "memory", factory: memoryExtension }];
let root: string;
const harnesses: Harness[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "scratch-pending-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

test("scratch records targeting this project surface once in its sessions", async () => {
	const harness = await createHarness({ extensionFactories: factories });
	harnesses.push(harness);
	const identity = resolveProjectIdentity(harness.tempDir);
	// A scratch record born in ANOTHER session, tagged for this project.
	getMemoryChannel().write({
		type: "anchor",
		title: "aitime deploy fact",
		body: "deploy from /opt/aitime",
		source: "user",
		scope: { scope: "scratch" },
		originSessionId: "session-elsewhere",
		originCwd: join(root, "elsewhere"),
		targetProjectId: identity.projectId,
	});

	harness.setResponses([fauxAssistantMessage("first")]);
	await harness.session.prompt("first question");
	const firstUser = getUserTexts(harness).at(-1)!;
	expect(firstUser).toContain("<scratch_pending>");
	expect(firstUser).toContain("aitime deploy fact");
	expect(firstUser).toContain("memory_promote");

	// The hint shows once per pending set: unchanged set stays silent.
	harness.setResponses([fauxAssistantMessage("second")]);
	await harness.session.prompt("second question");
	expect(getUserTexts(harness).at(-1)).not.toContain("<scratch_pending>");

	// A new pending record changes the fingerprint and re-surfaces.
	getRuntimeState();
	getMemoryChannel().write({
		type: "anchor",
		title: "second pending fact",
		body: "x",
		source: "user",
		scope: { scope: "scratch" },
		originSessionId: "session-elsewhere",
		originCwd: join(root, "elsewhere"),
		targetProjectId: identity.projectId,
	});
	harness.setResponses([fauxAssistantMessage("third")]);
	await harness.session.prompt("third question");
	expect(getUserTexts(harness).at(-1)).toContain("second pending fact");
});
