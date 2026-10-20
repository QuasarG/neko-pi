/**
 * Built-in memory extension: wires the MemoryStore into the agent loop.
 *
 * Three write channels funnel into one pipeline: lifecycle hooks (session
 * summary on shutdown), the memory_write tool (model-initiated, any time),
 * and human edits to the store directory (picked up on the next load —
 * files on disk are ground truth).
 */

import { Type } from "typebox";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { getMemoryStore, MEMORY_RECORD_TYPES } from "../../core/memory/store.ts";

const MEMORY_SECTION = "memory";

function formatRecall(results: ReturnType<ReturnType<typeof getMemoryStore>["recall"]>): string {
	if (results.length === 0) return "No matching memories.";
	return results
		.map(({ record, score }) => {
			const status = record.status ? ` [${record.status}]` : "";
			const date = record.updated.toISOString().slice(0, 10);
			return `## ${record.title}${status}\n(${record.type} · ${date} · relevance ${score.toFixed(2)})\n${record.body}`;
		})
		.join("\n\n");
}

const memoryExtension: ExtensionFactory = (pi) => {
	const store = getMemoryStore();

	pi.registerTool({
		name: "memory_write",
		label: "memory_write",
		description:
			"Write a long-term memory record. Use proactively whenever something worth remembering happens — promises made to the user, milestones, lessons learned, new preferences. " +
			'Types: promise (open commitment, track until fulfilled), episode (event with context), anchor (major fact to remember forever), whisper (private wish), profile (durable facts about the user), procedure (how to handle recurring situations). ' +
			"Set user_commanded=true when the user explicitly asked to remember something — such writes are never dropped.",
		parameters: Type.Object({
			type: Type.Union(MEMORY_RECORD_TYPES.map((t) => Type.Literal(t))), 
			title: Type.String({ description: "Short stable title; same type+title merges into one record" }),
			body: Type.String({ description: "The memory content itself, in your own voice" }),
			salience: Type.Optional(Type.Number({ description: "0-1 importance; defaults per type" })),
			tags: Type.Optional(Type.Array(Type.String())),
			user_commanded: Type.Optional(Type.Boolean({ description: "True when the user explicitly asked for this memory" })),
		}),
		execute: async (_toolCallId, params) => {
			const result = store.write({
				type: params.type,
				title: params.title,
				body: params.body,
				salience: params.salience,
				tags: params.tags,
				source: params.user_commanded ? "user" : "model",
			});
			return {
				content: [{ type: "text", text: `${result.action}${result.note ? `: ${result.note}` : ""} (${result.file})` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "memory_recall",
		description:
			"Search long-term memory by topic. Recall before answering questions about past events, prior commitments, or the user's established preferences.",
		parameters: Type.Object({
			query: Type.String({ description: "Topic, keywords, or a phrase to match" }),
			limit: Type.Optional(Type.Number({ description: "Max records (default 5)" })),
		}),
		execute: async (_toolCallId, params) => {
			const results = store.recall(params.query, params.limit ?? 5);
			return {
				content: [{ type: "text", text: formatRecall(results) }],
				details: { count: results.length },
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		const section = store.buildStandingContext();
		if (section) event.systemPromptOptions.sections[MEMORY_SECTION] = section;
		else delete event.systemPromptOptions.sections[MEMORY_SECTION];
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit" && event.reason !== "reload") return;
		let firstUserMessage = "";
		let cwd = "unknown cwd";
		try {
			const manager = ctx.sessionManager;
			cwd = manager.getCwd();
			for (const entry of manager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "user") {
					const content = entry.message.content;
					if (typeof content === "string") {
						if (content.trim()) {
							firstUserMessage = content;
							break;
						}
						continue;
					}
					const text = content.map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
					if (text) {
						firstUserMessage = text;
						break;
					}
				}
			}
		} catch {
			// Session already torn down; an empty summary episode is still useful.
		}
		if (firstUserMessage) {
			store.write({
				type: "episode",
				title: `session: ${firstUserMessage.replace(/\s+/g, " ").slice(0, 60)}`,
				body: `Working session in ${cwd}.`,
				source: "hook",
			});
		}
		store.consolidate();
	});
};

export default memoryExtension;
