import type { InlineExtension } from "../core/extensions/types.ts";
import askUserExtension from "./ask-user/index.ts";
import backgroundJobsExtension from "./background-jobs/index.ts";
import codemodeExtension from "./codemode/index.ts";
import goalExtension from "./goal/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import memoryExtension from "./memory/index.ts";
import runtimeContextExtension from "./runtime-context/index.ts";
import stylebankExtension from "./stylebank/index.ts";
import subagentsExtension from "./subagents/index.ts";
import todoExtension from "./todo/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import undoJournalExtension from "./undo-journal/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "runtime-context", factory: runtimeContextExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "memory", factory: memoryExtension, replaceable: true, builtin: true },
	{ name: "stylebank", factory: stylebankExtension, builtin: true },
	{ name: "background-jobs", factory: backgroundJobsExtension, builtin: true },
	{ name: "goal", factory: goalExtension, builtin: true },
	{ name: "subagents", factory: subagentsExtension, builtin: true },
	{ name: "ask-user", factory: askUserExtension, replaceable: true, builtin: true },
	{ name: "todo", factory: todoExtension, replaceable: true, builtin: true },
	{ name: "undo-journal", factory: undoJournalExtension, builtin: true },
];
