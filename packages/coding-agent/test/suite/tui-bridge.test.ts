import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { TuiBridge } from "../../src/modes/tui-bridge/server.ts";
import { createHarness, getUserTexts } from "./harness.ts";

it("delivers real pi tool and text events and retains the conversation for the next prompt", async () => {
	const harness = await createHarness({
		tools: [
			{
				name: "echo",
				label: "Echo",
				description: "Echo",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "tool output" }], details: {} }),
			},
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("first answer"),
		fauxAssistantMessage("second answer"),
	]);
	const bridge = new TuiBridge({
		onLog: () => {},
		createAgent: async () => ({
			prompt: (text) => harness.session.prompt(text),
			subscribe: (listener) => harness.session.subscribe(listener),
			abort: () => harness.session.abort(),
			waitForIdle: () => harness.session.waitForIdle(),
			dispose: () => {},
			setModel: async () => {},
		}),
	});
	const emitted = vi.spyOn(bridge, "publish");
	const port = await bridge.listen();
	const base = `http://127.0.0.1:${port}/api`;
	try {
		await fetch(`${base}/session`, {
			method: "POST",
			body: JSON.stringify({
				id: "ses_roundtrip",
				model: {
					providerID: harness.session.model!.provider,
					id: harness.session.model!.id,
				},
			}),
		});
		for (const [index, text] of ["first prompt", "second prompt"].entries()) {
			const response = await fetch(`${base}/session/ses_roundtrip/prompt`, {
				method: "POST",
				body: JSON.stringify({ id: `msg_roundtrip_${index}`, text }),
			});
			expect(response.status).toBe(200);
			await vi.waitFor(() =>
				expect(emitted.mock.calls.filter(([event]) => event.type === "session.execution.succeeded")).toHaveLength(
					index + 1,
				),
			);
		}
		expect(getUserTexts(harness)).toEqual(["first prompt", "second prompt"]);
		const events = emitted.mock.calls.map(([event]) => event.type);
		expect(events).toContain("session.text.delta");
		expect(events).toContain("session.tool.called");
		expect(events).toContain("session.tool.success");
		const history = await (await fetch(`${base}/session/ses_roundtrip/message`)).json();
		expect(history).toMatchObject({
			data: expect.arrayContaining([
				expect.objectContaining({
					type: "assistant",
					content: expect.arrayContaining([{ type: "text", text: "second answer" }]),
				}),
				expect.objectContaining({ type: "idle", outcome: "succeeded" }),
			]),
		});
		expect(await (await fetch(`${base}/session/ses_roundtrip/inbox`)).json()).toEqual({ data: [] });
		expect(await (await fetch(`${base}/session/active`)).json()).toEqual({ data: {} });
		const info = (await (await fetch(`${base}/session/ses_roundtrip`)).json()) as {
			data: { time: { idle: number } };
		};
		const viewed = await fetch(`${base}/session/ses_roundtrip/view`, {
			method: "POST",
			body: JSON.stringify({ idle: info.data.time.idle }),
		});
		expect(viewed.status).toBe(204);
		expect(await (await fetch(`${base}/session/ses_roundtrip`)).json()).toMatchObject({
			data: { time: { viewed: info.data.time.idle } },
		});
	} finally {
		await bridge.close();
		harness.cleanup();
	}
});

it("turns backend startup failures into a visible terminal error and clears pending input", async () => {
	const bridge = new TuiBridge({
		onLog: () => {},
		createAgent: async () => {
			throw new Error("Missing provider credentials");
		},
	});
	const emitted = vi.spyOn(bridge, "publish");
	const port = await bridge.listen();
	const base = `http://127.0.0.1:${port}/api`;
	try {
		await fetch(`${base}/session`, { method: "POST", body: JSON.stringify({ id: "ses_failure" }) });
		await fetch(`${base}/session/ses_failure/prompt`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
		await vi.waitFor(() =>
			expect(emitted.mock.calls.map(([event]) => event)).toContainEqual(
				expect.objectContaining({
					type: "session.execution.failed",
					data: { sessionID: "ses_failure", error: { type: "pi", message: "Missing provider credentials" } },
				}),
			),
		);
		expect(await (await fetch(`${base}/session/active`)).json()).toEqual({ data: {} });
		expect(await (await fetch(`${base}/session/ses_failure/inbox`)).json()).toEqual({ data: [] });
	} finally {
		await bridge.close();
	}
});
