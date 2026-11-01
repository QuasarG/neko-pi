import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isPowerShellToolEnabled,
  resolveDefaultToolEntries,
  resolveShellTools,
} = await createJiti(import.meta.url).import("./powershell-settings.ts");

test("PowerShell is opt-in on Windows and never selected on other platforms", () => {
  assert.equal(isPowerShellToolEnabled(undefined, "win32"), false);
  assert.equal(isPowerShellToolEnabled(["read", "powershell"], "win32"), true);
  assert.equal(isPowerShellToolEnabled(["read", "bash", "powershell"], "win32"), false);
  assert.equal(isPowerShellToolEnabled(["read", "powershell"], "darwin"), false);
  assert.deepEqual(
    resolveShellTools(["read", "bash", "edit"], ["read", "powershell"], "win32"),
    ["read", "powershell", "edit"],
  );
  assert.deepEqual(
    resolveShellTools(["read", "bash", "edit"], ["read", "powershell"], "darwin"),
    ["read", "bash", "edit"],
  );
});

test("defaultTools entries resolve like pi's +name / -name modifiers", () => {
  assert.deepEqual(resolveDefaultToolEntries([]), []);
  assert.deepEqual(resolveDefaultToolEntries(["read", "grep"]), ["read", "grep"]);
  assert.deepEqual(resolveDefaultToolEntries(["+codemode"]), ["read", "bash", "edit", "write", "codemode"]);
  assert.deepEqual(resolveDefaultToolEntries(["-bash", "+powershell"]), ["read", "edit", "write", "powershell"]);
  assert.deepEqual(resolveDefaultToolEntries(["read", "+grep", "-read"]), ["grep"]);
});
