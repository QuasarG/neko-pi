import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { ThemeSource } from "../../src/context/theme"

export const emptyThemeSource: ThemeSource = { discover: () => Promise.resolve({}) }

export async function tmpdir() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "opencode-tui-test-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      // Async writers (session-tab persistence, config saves) may still be
      // mid-flush when the test finishes; deleting underneath them raises
      // ENOENT on their side. Give them a beat to drain, then remove — and
      // retry once for a path a straggler recreated mid-delete.
      await new Promise((resolve) => setTimeout(resolve, 25))
      await rm(directory, { recursive: true, force: true })
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// Copies a plugin from fixture/plugin into a temporary directory that resolves this package's dependencies.
export async function copyPlugin(name: string) {
  const root = await tmpdir()
  const directory = path.join(root.path, name)
  const entry = path.join(directory, "tui.tsx")
  await mkdir(directory)
  await symlink(path.join(import.meta.dir, "../../node_modules"), path.join(directory, "node_modules"))
  await Bun.write(entry, Bun.file(path.join(import.meta.dir, "plugin", name, "tui.tsx")))
  return { directory, entry, [Symbol.asyncDispose]: root[Symbol.asyncDispose] }
}
