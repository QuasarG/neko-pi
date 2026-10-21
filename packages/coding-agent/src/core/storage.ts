import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export function atomicWrite(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function readState(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function withStorageLock<T>(file: string, action: () => T): T {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const deadline = performance.now() + 1000;
	let release: () => void;
	while (true) {
		try {
			release = lockfile.lockSync(file, { realpath: false });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || performance.now() >= deadline) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	try {
		return action();
	} finally {
		release();
	}
}
