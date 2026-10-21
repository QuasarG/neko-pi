import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { atomicWrite, withStorageLock } from "./storage.ts";

export function migrateUserState(source = join(homedir(), ".pi"), target = getAgentDir()): void {
	if (resolve(source) === resolve(target) || resolve(target).startsWith(`${resolve(source)}${sep}`))
		throw new Error("Migration target must be outside the legacy directory");
	if (!existsSync(source) || existsSync(join(target, "migrations", "pi.json"))) return;
	withStorageLock(join(target, "migrations", "migration"), () => {
		if (existsSync(join(target, "migrations", "pi.json"))) return;
		let protectedSource = false;
		const conflicts: string[] = [];
		const copy = (from: string, to: string) => {
			const info = lstatSync(from);
			if (basename(from) === "AGENTS.md") {
				protectedSource = true;
				return;
			}
			const destination = (() => {
				try {
					return lstatSync(to);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return undefined;
				}
			})();
			if (destination?.isSymbolicLink()) {
				conflicts.push(relative(source, from));
				return;
			}
			if (info.isDirectory()) {
				if (destination && !destination.isDirectory()) {
					conflicts.push(relative(source, from));
					return;
				}
				mkdirSync(to, { recursive: true, mode: info.mode & 0o777 });
				for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
				return;
			}
			if (info.isSymbolicLink()) {
				protectedSource = true;
				if (!existsSync(to)) symlinkSync(readlinkSync(from), to);
				else if (!lstatSync(to).isSymbolicLink() || readlinkSync(to) !== readlinkSync(from))
					conflicts.push(relative(source, from));
				return;
			}
			if (!info.isFile()) return;
			if (existsSync(to)) {
				if (!statSync(to).isFile() || !readFileSync(from).equals(readFileSync(to)))
					conflicts.push(relative(source, from));
				return;
			}
			copyFileSync(from, to);
			chmodSync(to, info.mode & 0o777);
			if (!readFileSync(from).equals(readFileSync(to))) throw new Error(`Migration verification failed: ${from}`);
		};
		for (const name of readdirSync(source)) {
			if (name === "agent" && lstatSync(join(source, name)).isDirectory()) {
				for (const item of readdirSync(join(source, name))) copy(join(source, name, item), join(target, item));
			} else copy(join(source, name), join(target, name));
		}
		const backup = join(target, "migrations", "legacy-pi");
		if (!protectedSource && !existsSync(backup)) renameSync(source, backup);
		atomicWrite(
			join(target, "migrations", "pi.json"),
			JSON.stringify(
				{ source, backup: protectedSource ? null : backup, conflicts, completed: new Date().toISOString() },
				null,
				2,
			),
		);
	});
}
