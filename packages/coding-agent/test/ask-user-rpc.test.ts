import { afterEach, describe, expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import askUserExtension, { QUESTION_TIMEOUT_MS } from "../src/extensions/ask-user/index.ts";

afterEach(() => vi.useRealTimers());

async function harness(opts?: { withSelectMultiple?: boolean }) {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
	let registered: ToolDefinition | undefined;
	const select = vi.fn<ExtensionUIContext["select"]>();
	const selectMultiple = vi.fn<NonNullable<ExtensionUIContext["selectMultiple"]>>();
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	// A host without the multi capability (older RPC client) must keep working.
	const ui = {
		select,
		...(opts?.withSelectMultiple === false ? {} : { selectMultiple }),
		setStatus: vi.fn(),
		notify: vi.fn(),
	} as unknown as ExtensionUIContext;
	const context = { ui, mode: "rpc", hasUI: true } as unknown as ExtensionToolContext;
	const api = {
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) => handlers.set(name, handler),
		registerTool: (definition: ToolDefinition) => {
			registered = definition;
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	await askUserExtension(api);
	handlers.get("session_start")?.({}, context);
	if (!registered) throw new Error("ask_user was not registered");
	const tool = registered;
	const execute = (background = false, multiSelect = false) =>
		tool.execute(
			"question-1",
			{
				question: "Which database?",
				options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "Redis" }],
				background,
				multi_select: multiSelect,
			},
			undefined,
			undefined,
			context,
		);
	return { execute, handlers, context, select, selectMultiple, sendMessage };
}

describe("ask_user RPC delivery", () => {
	test("foreground waits for a response and accepts an explicit free-text answer", async () => {
		const h = await harness();
		let answer: (value: string) => void = () => {};
		h.select.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		let settled = false;
		const result = h.execute().then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(h.select).toHaveBeenCalledOnce();
		answer("Use Redis");
		expect((await result).details).toEqual({ answered: true, labels: [], freeText: "Use Redis" });
	});

	test("multi-select questions go through the array-capable dialog and return the true label array", async () => {
		const h = await harness();
		let answer: (value: string[]) => void = () => {};
		h.selectMultiple.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		let settled = false;
		const result = h.execute(false, true).then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(h.selectMultiple).toHaveBeenCalledOnce();
		expect(h.select).not.toHaveBeenCalled();
		expect(h.selectMultiple.mock.calls[0][1]).toEqual(["Postgres", "SQLite", "Redis"]);
		// Whatever order the host answers in, the result keeps the offered order.
		answer(["Redis", "Postgres"]);
		const toolResult = await result;
		expect(toolResult.details).toEqual({ answered: true, labels: ["Postgres", "Redis"] });
		expect(toolResult.content).toEqual([{ type: "text", text: "The user chose: Postgres, Redis" }]);
	});

	test("a multi-select free-text answer still comes back as free text, not a fake label join", async () => {
		const h = await harness();
		h.selectMultiple.mockResolvedValue(["Use Redis instead"]);
		const toolResult = await h.execute(false, true);
		expect(toolResult.details).toEqual({ answered: true, labels: [], freeText: "Use Redis instead" });
		expect(toolResult.content).toEqual([{ type: "text", text: "The user answered: Use Redis instead" }]);
	});

	test("an empty multi-select pick set counts as no answer", async () => {
		const h = await harness();
		h.selectMultiple.mockResolvedValue([]);
		const toolResult = await h.execute(false, true);
		expect(toolResult.details).toEqual({ answered: false });
	});

	test("hosts without the multi capability degrade to a single-choice select", async () => {
		const h = await harness({ withSelectMultiple: false });
		h.select.mockResolvedValue("SQLite");
		const toolResult = await h.execute(false, true);
		expect(h.select).toHaveBeenCalledOnce();
		expect(toolResult.details).toEqual({ answered: true, labels: ["SQLite"] });
	});

	test("background returns before asking, then delivers an actual answer as a new turn", async () => {
		const h = await harness();
		let answer: (value: string) => void = () => {};
		h.select.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const result = await h.execute(true);
		expect(result.details).toMatchObject({ background: true });
		expect(h.select).not.toHaveBeenCalled();
		h.handlers.get("agent_end")?.({}, h.context);
		expect(h.select).toHaveBeenCalledOnce();
		expect(h.sendMessage).not.toHaveBeenCalled();
		answer("SQLite");
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledOnce());
		expect(h.sendMessage.mock.calls[0][0]).toMatchObject({
			customType: "ask-user-answer",
			details: { labels: ["SQLite"] },
		});
		expect(h.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
	});

	test("a multi-select background answer delivers the whole label array", async () => {
		const h = await harness();
		let answer: (value: string[]) => void = () => {};
		h.selectMultiple.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		await h.execute(true, true);
		h.handlers.get("agent_end")?.({}, h.context);
		expect(h.selectMultiple).toHaveBeenCalledOnce();
		answer(["Postgres", "Redis"]);
		await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledOnce());
		expect(h.sendMessage.mock.calls[0][0]).toMatchObject({
			customType: "ask-user-answer",
			details: { labels: ["Postgres", "Redis"] },
		});
	});

	test("an expired background question never opens or wakes the model", async () => {
		vi.useFakeTimers();
		const h = await harness();
		await h.execute(true);
		await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS);
		h.handlers.get("agent_end")?.({}, h.context);
		expect(h.select).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	test("skipping a background question sends no answer or continuation", async () => {
		const h = await harness();
		h.select.mockResolvedValue(undefined);
		await h.execute(true);
		h.handlers.get("agent_end")?.({}, h.context);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});
