/**
 * Runtime settings the bridge exposes to the TUI.
 *
 * The "interface" group of the settings dialog is the TUI's own local config
 * and never leaves the TUI process. This adapter is the other group: pi's own
 * runtime settings, read from and written to pi's SettingsManager so a change
 * survives a restart and applies to the next session.
 *
 * Every key is mapped to a SettingsManager call. A key that is not listed here
 * is rejected instead of being written blindly, so a typo cannot silently
 * create a setting that pi never reads.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "../../core/settings-manager.ts";

export interface RuntimeSettingDescriptor {
	/** Stable key used by the TUI and the HTTP API. */
	key: string;
	/** Human-readable label shown in the settings dialog. */
	label: string;
	/** Value type, so the TUI can render the right control. */
	type: "string" | "boolean" | "enum";
	/** Allowed values for enum settings. */
	values?: readonly string[];
	/** One line explaining where the value applies. */
	description: string;
	/** Whether a change takes effect for sessions that are already running. */
	appliesTo: "next-session" | "immediately";
}

export const RUNTIME_SETTING_DESCRIPTORS: readonly RuntimeSettingDescriptor[] = [
	{
		key: "defaultProvider",
		label: "默认提供商",
		type: "string",
		description: "无会话时使用的模型提供商。",
		appliesTo: "next-session",
	},
	{
		key: "defaultModel",
		label: "默认模型",
		type: "string",
		description: "无会话时使用的模型 id。",
		appliesTo: "next-session",
	},
	{
		key: "defaultThinkingLevel",
		label: "默认思考强度",
		type: "enum",
		values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		description: "新会话的思考强度；不支持推理的模型会忽略该值。",
		appliesTo: "next-session",
	},
	{
		key: "hideThinkingBlock",
		label: "隐藏思考内容",
		type: "boolean",
		description: "不在会话里显示模型的思考内容。",
		appliesTo: "immediately",
	},
	{
		key: "compactionEnabled",
		label: "自动压缩",
		type: "boolean",
		description: "上下文接近上限时自动压缩历史。",
		appliesTo: "immediately",
	},
	{
		key: "retryEnabled",
		label: "失败自动重试",
		type: "boolean",
		description: "提供商请求失败时自动重试。",
		appliesTo: "immediately",
	},
];

const DESCRIPTORS_BY_KEY = new Map(RUNTIME_SETTING_DESCRIPTORS.map((entry) => [entry.key, entry]));

/** Values pi's SettingsManager holds for the exposed runtime settings. */
export interface RuntimeSettingsValues {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	hideThinkingBlock: boolean;
	compactionEnabled: boolean;
	retryEnabled: boolean;
}

/** Read and write pi's runtime settings through SettingsManager. */
export class RuntimeSettings {
	private readonly settings: SettingsManager;

	constructor(settings: SettingsManager) {
		this.settings = settings;
	}

	/** The current values, exactly as pi holds them. */
	read(): Record<string, unknown> {
		return { ...this.readValue() };
	}

	private readValue(): RuntimeSettingsValues {
		const thinking = this.settings.getDefaultThinkingLevel();
		return {
			defaultProvider: this.settings.getDefaultProvider(),
			defaultModel: this.settings.getDefaultModel(),
			defaultThinkingLevel: thinking === undefined ? undefined : String(thinking),
			hideThinkingBlock: this.settings.getHideThinkingBlock(),
			compactionEnabled: this.settings.getCompactionEnabled(),
			retryEnabled: this.settings.getRetryEnabled(),
		};
	}

	/**
	 * Apply a patch and persist it. Returns the values after the write, read
	 * back from the manager, so the caller sees what actually landed.
	 */
	async write(patch: Record<string, unknown>): Promise<RuntimeSettingsValues> {
		for (const [key, value] of Object.entries(patch)) {
			const descriptor = DESCRIPTORS_BY_KEY.get(key);
			if (!descriptor) throw new Error(`Unknown runtime setting: ${key}`);
			switch (key) {
				case "defaultProvider":
					if (typeof value !== "string" || value.trim() === "") {
						throw new Error("defaultProvider must be a non-empty string");
					}
					this.settings.setDefaultProvider(value.trim());
					break;
				case "defaultModel":
					if (typeof value !== "string" || value.trim() === "") {
						throw new Error("defaultModel must be a non-empty string");
					}
					this.settings.setDefaultModel(value.trim());
					break;
				case "defaultThinkingLevel":
					if (typeof value !== "string" || !descriptor.values?.includes(value)) {
						throw new Error(`defaultThinkingLevel must be one of: ${descriptor.values?.join(", ")}`);
					}
					this.settings.setDefaultThinkingLevel(value as ThinkingLevel);
					break;
				case "hideThinkingBlock":
					if (typeof value !== "boolean") throw new Error("hideThinkingBlock must be a boolean");
					this.settings.setHideThinkingBlock(value);
					break;
				case "compactionEnabled":
					if (typeof value !== "boolean") throw new Error("compactionEnabled must be a boolean");
					this.settings.setCompactionEnabled(value);
					break;
				case "retryEnabled":
					if (typeof value !== "boolean") throw new Error("retryEnabled must be a boolean");
					this.settings.setRetryEnabled(value);
					break;
			}
		}
		await this.settings.flush();
		return { ...this.readValue() };
	}
}
