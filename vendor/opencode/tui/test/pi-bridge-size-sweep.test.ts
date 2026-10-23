import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { createTestRenderer } from "@opentui/core/testing"
import { Global } from "@opencode/util/global"
import { createRoot } from "solid-js"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"
import { run } from "../src/app"
import { tmpdir as createState } from "./fixture/fixture"
import type { AgentSessionEvent } from "../../../../packages/coding-agent/src/core/agent-session"

// Batch UI check across the terminal sizes the product is used at
// (120x40, 150x44, 80x24, 44x20): the app must boot, keep the status area
// blank, and accept an Enter-submitted prompt at every size.
const SIZES = [
  { width: 120, height: 40 },
  { width: 150, height: 44 },
  { width: 80, height: 24 },
  { width: 44, height: 20 },
] as const

test.each(SIZES)("bridge TUI stays usable at %dx%d", async (size) => {
  const home = mkdtempSync(join(tmpdir(), "pi-sweep-"))
  try {
    await using state = await createState()
    const modelsPath = join(state.path, "models.json")
    writeFileSync(modelsPath, JSON.stringify({ providers: { demo: { models: [{ id: "sweep-model" }] } } }))
    const requests: string[] = []
    let listener: ((event: AgentSessionEvent) => void) | undefined
    const bridge = new TuiBridge({
      defaultDirectory: home,
      modelsPath,
      onLog: (line) => requests.push(line),
      personaStatus: () => ({ name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 1, lintConfigured: true }),
      createAgent: async () => ({
        subscribe(fn) { listener = fn; return () => { listener = undefined } },
        async prompt() {
          const message = {
            role: "assistant" as const, api: "openai-completions" as const,
            provider: "demo", model: "sweep-model", timestamp: Date.now(),
            content: [{ type: "text" as const, text: "sweep reply" }],
            stopReason: "stop" as const,
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          }
          listener?.({ type: "message_start", message })
          listener?.({ type: "message_end", message })
        },
        async setModel() {}, async abort() {}, async waitForIdle() {}, dispose() {},
      }),
    })
    const port = await bridge.listen()
    const setup = await createTestRenderer({ width: size.width, height: size.height, kittyKeyboard: true })
    await setup.renderer.setupTerminal()
    setup.renderer.start()
    const ready = Promise.withResolvers<void>()
    const task = Effect.runPromise(run({
      app: { name: "neko-pi", version: "test", channel: "test", nekoEndpoint: `http://127.0.0.1:${port}`, persona: {
        name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 1, lintConfigured: true,
      } },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: {}, log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))))
    try {
      await ready.promise
      const boot = await setup.waitForFrame((frame) => frame.includes("Ask anything"))
      expect(boot).not.toContain("crashed")
      expect(boot).not.toContain("Getting started")
      // The status/portrait area stays blank at every size.
      expect(boot).not.toContain("运行记忆")
      await setup.mockInput.typeText("size sweep")
      setup.mockInput.pressEnter()
      await setup.waitForFrame(() => requests.some((line) => /^POST \/api\/session\/[^/]+\/prompt/.test(line)))
      const reply = await setup.waitForFrame((frame) => frame.includes("sweep reply"))
      expect(reply).not.toContain("crashed")
      expect(requests.filter((line) => line.startsWith("MISSING"))).toEqual([])
    } finally {
      setup.renderer.destroy()
      await task
      await bridge.close()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
