import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearFinishedBackgroundJobs, listBackgroundJobs } from "../../src/core/tools/background-jobs.ts";
import subagentsExtension from "../../src/extensions/subagents/index.ts";
import { createHarness, getMessageText } from "./harness.ts";

const factories = [{ name: "subagents", factory: subagentsExtension }];
let root: string;
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "subagents-suite-"));
	vi.stubEnv("NEKO_PI_HOME", root);
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	clearFinishedBackgroundJobs();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

test("the subagent tool is registered and unknown agents fail with the available list", async () => {
	const harness = await createHarness({ extensionFactories: factories });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { agent: "nobody", task: "x" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("dispatch a subagent");
	const result = harness.session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "subagent",
	);
	expect(result?.isError).toBe(true);
	expect(getMessageText(result!)).toContain("Unknown agent: nobody");
	expect(getMessageText(result!)).toContain("scout");
	expect(getMessageText(result!)).toContain("worker");
});

test("SDK-hosted subagents launch the package CLI in the requested project", async () => {
	vi.stubEnv("PI_PACKAGE_DIR", root);
	mkdirSync(join(root, "dist"));
	writeFileSync(
		join(root, "dist", "cli.js"),
		[
			"console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',",
			"content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), noPersona: process.env.NEKO_PI_NO_PERSONA }) }] } }));",
		].join("\n"),
	);
	const childCwd = join(root, "child-project");
	mkdirSync(childCwd);
	const harness = await createHarness({ extensionFactories: factories });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("subagent", { agent: "scout", task: "inspect", background: false, cwd: childCwd }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("dispatch a fixture child");
	const result = harness.session.messages.findLast(
		(message) => message.role === "toolResult" && message.toolName === "subagent",
	);
	if (result?.role !== "toolResult") throw new Error("Missing subagent result");
	expect(result.isError).toBe(false);
	const child = JSON.parse(getMessageText(result)) as { cwd: string; args: string[]; noPersona: string };
	expect(child.cwd).toBe(childCwd);
	expect(child.noPersona).toBe("1");
	expect(child.args).toEqual(expect.arrayContaining(["--mode", "json", "--print", "--no-session", "--no-extensions"]));
	expect(listBackgroundJobs(harness.session.sessionId)).toMatchObject([
		{ kind: "subagent", status: "completed", notify: false },
	]);
});
