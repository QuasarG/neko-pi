import { expect, spyOn, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { mkdirSync } from "node:fs"
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
    const identityName = `persona-${width}.md`
    const files = [
      { path: join(root.path, `identity ${width}.md`), name: identityName, kind: "identity" as const, available: true, directory: false },
      { path: join(root.path, "missing.md"), name: `missing-${width}.md`, kind: "memory" as const, available: false, directory: false },
    ]
    const opener = spyOn(Open, "openPath").mockImplementation(async () => new ChildProcess())
    // memoryRoot points at an empty fixture dir: the default would scan the
    // developer's real ~/.neko_pi memory (8+ records), drowning the fixture
    // rows out of the scrollbox view.
    mkdirSync(join(root.path, "memory"), { recursive: true })
    const bridge = new TuiBridge({ modelsPath: join(root.path, "missing-models.json"), memoryRoot: join(root.path, "memory"), personaFiles: () => files, onLog: () => {} })
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
        await setup.waitForFrame((frame) => frame.includes("人设关联文件") && frame.includes(identityName))
        const row = setup.renderer.root.findDescendantById("neko.persona-file.identity.0")
        if (!row) {
          const all: string[] = []
          setup.renderer.root.traverse?.((node: { id?: string }) => { if (node.id?.includes("neko.persona-file")) all.push(node.id) })
          console.log("DBG ids:", JSON.stringify(all))
        }
        const row2 = row!
        expect(row2.x).toBeGreaterThan(width / 2)
        expect(row2.y + row2.height).toBeLessThan(height)
        await setup.mockMouse.click(row2.x + 2, row2.y)
        await setup.waitForFrame(() => opener.mock.calls.length === 1)
        expect(opener).toHaveBeenCalledWith(files[0]!.path)
        const missing = setup.renderer.root.findDescendantById("neko.persona-file.memory.0")!
        await setup.mockMouse.click(missing.x + 2, missing.y)
        expect(opener).toHaveBeenCalledTimes(1)
        files[0]!.name = `${identityName}-updated`
        await setup.waitForFrame((frame) => frame.includes(`${identityName}-updated`), { maxPasses: 200 })
      } else expect(setup.captureCharFrame()).not.toContain("人设关联文件")
      // Re-seat focus on the composer: earlier row clicks + scrollbox
      // interactions can leave it blurred, and keystrokes then go nowhere.
      const composer = setup.renderer.root.findDescendantById("prompt")
      if (composer) await setup.mockMouse.click(composer.x + 2, composer.y)
      await setup.mockInput.typeText("/persona-files")
      // Gate on the command suggestion (its title differs from the panel
      // header): Enter before the suggestion appears submits the text as a
      // message and the dialog never opens.
      await setup.waitForFrame((frame) => frame.includes("查看并打开"), { maxPasses: 100 })
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("搜索文件名或路径"), { maxPasses: 100 })
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
