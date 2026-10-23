import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createTestRenderer } from "@opentui/core/testing"
import { run } from "../src/app"
import { tmpdir } from "./fixture/fixture"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"

for (const mode of ["edit", "unresolved", "retry"] as const) {
  const available = mode !== "unresolved"
  test(`message action ${mode}`, async () => {
    await using root = await tmpdir()
    const now = Date.now()
    writeFileSync(join(root.path, "ses_edit.json"), JSON.stringify({
      id: "ses_edit", directory: root.path, agent: "build", title: "edit fixture",
      created: now, updated: now, idle: now, seq: 0, messages: [], outcome: mode === "retry" ? "failed" : undefined,
      entryByMessage: available ? { msg_question: "entry_question" } : {},
      history: [{ id: "msg_question", type: "user", text: "EDIT_QUESTION", time: { created: now } }],
    }))
    let calls = 0
    let prompts = 0
    const bridge = new TuiBridge({
      defaultDirectory: root.path, stateDir: root.path, modelsPath: join(root.path, "missing.json"),
      onLog: () => {},
      createAgent: async () => ({
        prompt: async (text) => { expect(text).toBe("EDIT_QUESTION"); prompts++ }, subscribe: () => () => {}, abort: async () => {},
        waitForIdle: async () => {}, dispose: () => {}, setModel: async () => {},
        truncate: async () => { calls++ },
      }),
    })
    const port = await bridge.listen()
    const setup = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true })
    await setup.renderer.setupTerminal()
    setup.renderer.start()
    const ready = Promise.withResolvers<void>()
    const task = Effect.runPromise(run({
      app: { name: "neko-pi", version: "test", channel: "test", nekoEndpoint: `http://127.0.0.1:${port}` },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } }, args: { sessionID: "ses_edit" },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: root.path })), Effect.provide(FileSystem.layerNoop({}))))
    try {
      await ready.promise
      await setup.waitForFrame((frame) => frame.includes("EDIT_QUESTION"), { maxPasses: 200 })
      const row = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("EDIT_QUESTION"))
      await setup.mockMouse.click(8, row)
      await setup.waitForFrame((frame) => frame.includes("Edit and resend"))
      const menu = setup.captureCharFrame().split("\n")
      const action = mode === "retry" ? "Retry" : "Edit and resend"
      const editRow = menu.findIndex((line) => line.includes(action))
      const editCol = menu[editRow]!.indexOf(action)
      await setup.mockMouse.click(editCol + 2, editRow)
      if (mode === "retry") {
        await setup.waitForFrame(() => prompts === 1)
        expect(calls).toBe(0)
      } else if (available) {
        await setup.waitForFrame(() => calls === 1)
        await setup.waitForFrame((frame) => !frame.includes("Message Actions") && frame.includes("EDIT_QUESTION"))
        const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_edit/message`)
        expect((await response.json() as { data: unknown[] }).data).toEqual([])
      } else {
        await setup.waitForFrame((frame) => frame.includes("Cannot resolve this message"))
        expect(calls).toBe(0)
      }
    } finally {
      setup.renderer.destroy()
      await task
      await bridge.close()
    }
  }, 30000)
}
