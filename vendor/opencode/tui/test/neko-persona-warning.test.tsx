import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createTestRenderer } from "@opentui/core/testing"
import { run } from "../src/app"
import { tmpdir } from "./fixture/fixture"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"

/**
 * The persona-files panel must surface external file edits: when a managed
 * file changes on disk between refreshes, the row gains a ⚠ 已修改 marker and
 * the panel header shows a warning naming the changed files.
 */
test("persona panel flags externally modified files with a warning", async () => {
  await using root = await tmpdir()
  mkdirSync(join(root.path, "persona-pk"), { recursive: true })
  mkdirSync(join(root.path, "memory"), { recursive: true })
  const identityPath = join(root.path, "persona-pk", "persona.md")
  writeFileSync(identityPath, "# identity v1")

  let modifiedAt = Date.now()
  const files = () => [
    {
      path: identityPath,
      name: "persona.md",
      kind: "identity" as const,
      available: true,
      directory: false,
      modifiedAt,
    },
  ]
  const bridge = new TuiBridge({
    modelsPath: join(root.path, "missing-models.json"),
    memoryRoot: join(root.path, "memory"),
    personaFiles: () => files(),
    onLog: () => {},
  })
  const port = await bridge.listen()
  const setup = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const task = Effect.runPromise(
    run({
      app: {
        name: "neko-pi",
        version: "test",
        channel: "test",
        nekoEndpoint: `http://127.0.0.1:${port}`,
        persona: { name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 0, lintConfigured: false },
      },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } },
      args: {},
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      log: () => {},
    }).pipe(
      Effect.provide(Global.layerWith({ state: root.path })),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  try {
    await ready.promise
    // Baseline: the identity row renders WITHOUT a change marker.
    await setup.waitForFrame((frame) => frame.includes("人设关联文件") && frame.includes("persona.md"))
    await setup.waitForFrame((frame) => !frame.includes("已修改"), { maxPasses: 30 })

    // External edit: mtime moves on the next poll (2s cadence).
    modifiedAt = Date.now() + 1000
    writeFileSync(identityPath, "# identity v2 — hand edited")

    // The row flags the change and the warning strip counts it.
    await setup.waitForFrame((frame) => frame.includes("persona.md ⚠ 已修改"), { maxPasses: 100 })
    await setup.waitForFrame((frame) => frame.includes("1 个文件已变更"), { maxPasses: 30 })
    // The warning strip names the file and explains the consequence (the
    // sentence wraps inside the narrowing card, so match the stable prefix).
    await setup.waitForFrame((frame) => frame.includes("变更将在下一条消息"), { maxPasses: 30 })
    expect(setup.captureCharFrame()).not.toContain("crashed")
  } finally {
    setup.renderer.destroy()
    await task
    await bridge.close()
  }
}, 20000)
