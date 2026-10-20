import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { basename, relative } from "node:path";
import { type Component, getCapabilities, Image, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { loadPersonaPack, type PersonaPack } from "../../../core/persona/loader.ts";
import { getAgentDir } from "../../../config.ts";
import { formatTokens } from "./footer.ts";
import { theme } from "../theme/theme.ts";

/**
 * Right-hand sidebar for the fullscreen layout: persona avatar, identity and
 * session info, plus a compact project session tree. Content comes entirely
 * from the installed persona pack (avatar frames) and the live session, so the
 * component stays persona-agnostic.
 */

export interface PersonaSidebarMemoryInfo {
	totalRecords: number;
	byType: Record<string, number>;
	lastWrite: Date | null;
}

export interface PersonaSidebarOptions {
	session: AgentSession;
	isBusy: () => boolean;
	requestRender: () => void;
	getMemoryInfo?: () => PersonaSidebarMemoryInfo | undefined;
}

const SIDEBAR_WIDTH = 34;
const MIN_TERMINAL_WIDTH = 100;
const AVATAR_STATES = ["happy_night_desk", "angry_night_desk", "flustered_night_desk", "sad_night_desk",
	"happy_cozy", "angry_cozy", "flustered_cozy", "sad_cozy"] as const;

const avatarCache = new Map<string, string[]>();

function loadAvatarFrame(state: string): string[] {
	const cached = avatarCache.get(state);
	if (cached) return cached;
	const path = join(getAgentDir(), "persona", "theme", "avatar", "hd", "ans32", `${state}.ans`);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf-8").replace(/\n+$/, "").split("\n");
	avatarCache.set(state, lines);
	return lines;
}

function timeAgo(date: Date): string {
	const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function padEndVisible(line: string, width: number): string {
	const pad = width - visibleWidth(line);
	return pad > 0 ? line + " ".repeat(pad) : line;
}

interface SessionRow {
	info: SessionInfo;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
}

function buildSessionRows(sessions: SessionInfo[]): SessionRow[] {
	const byPath = new Map<string, { info: SessionInfo; children: string[] }>();
	for (const info of sessions) byPath.set(info.path, { info, children: [] });
	const roots: string[] = [];
	for (const info of sessions) {
		const parent = info.parentSessionPath && byPath.has(info.parentSessionPath) ? byPath.get(info.parentSessionPath) : undefined;
		if (parent) parent.children.push(info.path);
		else roots.push(info.path);
	}
	const byModified = (a: string, b: string) => byPath.get(b)!.info.modified.getTime() - byPath.get(a)!.info.modified.getTime();
	roots.sort(byModified);
	const rows: SessionRow[] = [];
	const walk = (path: string, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		const node = byPath.get(path)!;
		rows.push({ info: node.info, depth, isLast, ancestorContinues });
		node.children.sort(byModified);
		node.children.forEach((child, index) => {
			const childIsLast = index === node.children.length - 1;
			walk(child, depth + 1, [...ancestorContinues, depth > 0 ? !isLast : false], childIsLast);
		});
	};
	roots.forEach((root, index) => walk(root, 0, [], index === roots.length - 1));
	return rows;
}

export class PersonaSidebar implements Component {
	private readonly session: AgentSession;
	private readonly isBusy: () => boolean;
	private readonly requestRender: () => void;
	private readonly getMemoryInfo?: () => PersonaSidebarMemoryInfo | undefined;
	private readonly persona: PersonaPack | null;
	private sessions: SessionRow[] = [];
	private flashState: string | null = null;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private avatarImages = new Map<string, Image>();

	constructor(options: PersonaSidebarOptions) {
		this.session = options.session;
		this.isBusy = options.isBusy;
		this.requestRender = options.requestRender;
		this.getMemoryInfo = options.getMemoryInfo;
		this.persona = loadPersonaPack();
		void this.loadSessions();
	}

	setSession(session: AgentSession): void {
		void this.loadSessions();
	}

	flashAvatar(state: string, ms = 3000): void {
		if (!(AVATAR_STATES as readonly string[]).includes(state)) return;
		this.flashState = state;
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flashState = null;
			this.requestRender();
		}, ms);
		this.requestRender();
	}

	private async loadSessions(): Promise<void> {
		try {
			const manager = this.session.sessionManager;
			const infos = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
			this.sessions = buildSessionRows(infos).slice(0, 8);
			this.requestRender();
		} catch {
			this.sessions = [];
		}
	}

	private avatarLines(width: number): { lines: string[]; graphic: boolean } {
		const state = this.flashState ?? (this.isBusy() ? "happy_night_desk" : "happy_cozy");
		// Terminals with a graphics protocol get the full-resolution cutout PNG;
		// everyone else falls back to the 32-column half-block art.
		if (getCapabilities().images) {
			let image = this.avatarImages.get(state);
			if (!image) {
				const pngPath = join(getAgentDir(), "persona", "theme", "avatar", "hd", `${state}.png`);
				if (existsSync(pngPath)) {
					image = new Image(readFileSync(pngPath).toString("base64"), "image/png", { fallbackColor: (s) => theme.fg("dim", s) }, { maxWidthCells: 32 });
					this.avatarImages.set(state, image);
				}
			}
			if (image) return { lines: image.render(width), graphic: true };
		}
		return { lines: loadAvatarFrame(state), graphic: false };
	}

	private sectionLabel(label: string): string[] {
		return [theme.fg("accent", theme.bold(label))];
	}

	private infoLine(label: string, value: string, valueColor: "text" | "muted" | "accent" = "muted"): string[] {
		const key = theme.fg("dim", padEndVisible(label, 8));
		const text = truncateToWidth(value, SIDEBAR_WIDTH - 10);
		return [`${key}${theme.fg(valueColor, text)}`];
	}

	private contextBar(): string[] {
		const usage = this.session.getContextUsage();
		const percent = usage?.percent;
		if (percent === null || percent === undefined) {
			return this.infoLine("context", "—");
		}
		const filled = Math.round((percent / 100) * 10);
		const color: "muted" | "warning" | "error" = percent < 60 ? "muted" : percent < 85 ? "warning" : "error";
		const bar = "▮".repeat(Math.min(10, filled)) + "▯".repeat(Math.max(0, 10 - filled));
		return [`${theme.fg("dim", padEndVisible("context", 8))}${theme.fg(color, `${bar} ${percent.toFixed(0)}%`)}`];
	}

	private lastTurnTokens(): string[] {
		for (let i = this.session.sessionManager.getEntries().length - 1; i >= 0; i--) {
			const entry = this.session.sessionManager.getEntries()[i];
			if (entry?.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
				const { input, output } = entry.message.usage;
				const parts: string[] = [];
				if (input) parts.push(`↑${formatTokens(input)}`);
				if (output) parts.push(`↓${formatTokens(output)}`);
				return this.infoLine("turn", parts.join(" ") || "—");
			}
		}
		return [];
	}

	private memoryLines(): string[] {
		const info = this.getMemoryInfo?.();
		if (!info) return [];
		const last = info.lastWrite ? ` · ${timeAgo(info.lastWrite)}` : "";
		return this.infoLine("memory", `${info.totalRecords} records${last}`);
	}

	private personaLines(): string[] {
		if (!this.persona) {
			return this.infoLine("persona", "no pack installed", "text");
		}
		const loaded = this.persona.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return this.infoLine("persona", `${this.persona.name} · ${loaded}`, "accent");
	}

	private sessionTreeLines(): string[] {
		if (this.sessions.length === 0) return [theme.fg("muted", "  (no sessions)")];
		const currentId = this.session.sessionManager.getSessionId();
		const lines: string[] = [];
		for (const row of this.sessions.slice(0, 7)) {
			const prefix = row.ancestorContinues.map((c) => (c ? "│ " : "  ")).join("") + (row.depth === 0 ? "" : row.isLast ? "└ " : "├ ");
			const current = row.info.id === currentId;
			const title = row.info.name?.trim() || row.info.firstMessage.replace(/\s+/g, " ").trim() || row.info.id;
			const label = `${prefix}${current ? "▸ " : ""}${truncateToWidth(title, 16)}`;
			const meta = theme.fg("dim", ` ${timeAgo(row.info.modified)} · ${row.info.messageCount}msg`);
			const body = padEndVisible(label, SIDEBAR_WIDTH - 2 - visibleWidth(meta));
			lines.push((current ? theme.fg("accent", body) : theme.fg("muted", body)) + meta);
		}
		return lines;
	}

	invalidate(): void {
		// State is read at render time; nothing to invalidate.
	}

	render(width: number): string[] {
		const columns = process.stdout.columns ?? MIN_TERMINAL_WIDTH;
		if (columns < MIN_TERMINAL_WIDTH || width < SIDEBAR_WIDTH) return [];

		const lines: string[] = [""];

		const avatar = this.avatarLines(width);
		for (const avatarLine of avatar.lines) {
			// Kitty/iterm escapes must start the line; text prefixes would offset the placement.
			lines.push(avatarLine);
		}
		lines.push("");

		lines.push(...this.personaLines());
		const modelId = this.session.state.model ? `${this.session.state.model.provider}/${this.session.state.model.id}` : "—";
		lines.push(...this.infoLine("model", modelId));
		lines.push(...this.contextBar());
		lines.push(...this.lastTurnTokens());
		lines.push(...this.memoryLines());
		lines.push("");

		const cwd = this.session.sessionManager.getCwd();
		const project = basename(cwd) || relative("", cwd);
		lines.push(...this.sectionLabel(project));
		lines.push(...this.sessionTreeLines());
		return lines;
	}
}
