import { expect, spyOn, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import * as Open from "@opencode/util/open"
import { createTestRenderer } from "@opentui/core/testing"
import { run } from "../src/app"
import { tmpdir } from "./fixture/fixture"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"

for (const [width, height, sessionView] of [[120, 40, false], [150, 44, true], [80, 24, false], [44, 20, false]] as const) {
  test(`persona bindings refresh and open at ${width}x${height} (${sessionView ? "session" : "home"})`, async () => {
    await using root = await tmpdir()
    const files = [
      { path: join(root.path, "identity with spaces; literal.md"), name: "persona.md", kind: "identity" as const, available: true, directory: false },
      { path: join(root.path, "missing.md"), name: "missing.md", kind: "memory" as const, available: false, directory: false },
    ]
    const opener = spyOn(Open, "openPath").mockImplementation(async () => new ChildProcess())
    const bridge = new TuiBridge({ modelsPath: join(root.path, "missing-models.json"), personaFiles: () => files, onLog: () => {} })
    const port = await bridge.listen()
    if (sessionView) {
      for (let index = 0; index < 8; index++) files.push({ ...files[1]!, name: `reference-${index}.md`, path: join(root.path, `reference-${index}.md`) })
      await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST", body: JSON.stringify({ id: "ses_files" }) })
    }
    const setup = await createTestRenderer({ width, height, kittyKeyboard: true })
    await setup.renderer.setupTerminal()
    setup.renderer.start()
    const ready = Promise.withResolvers<void>()
    const task = Effect.runPromise(run({
      app: { name: "neko-pi", version: "test", channel: "test", nekoEndpoint: `http://127.0.0.1:${port}`, persona: { name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 0, lintConfigured: false } },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } }, args: sessionView ? { sessionID: "ses_files" } : {},
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }), log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: root.path })), Effect.provide(FileSystem.layerNoop({}))))
    try {
      await ready.promise
      await setup.waitForFrame((frame) => frame.includes(sessionView ? "New session" : "Ask anything"))
      if (width >= 110) {
        await setup.waitForFrame((frame) => frame.includes("人设关联文件") && frame.includes("persona.md"))
        const row = setup.renderer.root.findDescendantById("neko.persona-file.0")!
        expect(row.x).toBeGreaterThan(width / 2)
        expect(row.y + row.height).toBeLessThan(height)
        await setup.mockMouse.click(row.x + 2, row.y)
        await setup.waitForFrame(() => opener.mock.calls.length === 1)
        expect(opener).toHaveBeenCalledWith(files[0]!.path)
        const missing = setup.renderer.root.findDescendantById("neko.persona-file.1")!
        await setup.mockMouse.click(missing.x + 2, missing.y)
        expect(opener).toHaveBeenCalledTimes(1)
        files[0]!.name = "updated.md"
        await setup.waitForFrame((frame) => frame.includes("updated.md"), { maxPasses: 100 })
      } else expect(setup.captureCharFrame()).not.toContain("人设关联文件")
      await setup.mockInput.typeText("/persona-files")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("搜索文件名或路径"))
      setup.mockInput.pressEnter()
      await setup.waitForFrame(() => opener.mock.calls.length === (width >= 110 ? 2 : 1))
      expect(opener.mock.calls.at(-1)?.[0]).toBe(files[0]!.path)
      expect(setup.captureCharFrame()).not.toContain("crashed")
    } finally {
      opener.mockRestore()
      setup.renderer.destroy()
      await task
      await bridge.close()
    }
  }, 10000)
}
