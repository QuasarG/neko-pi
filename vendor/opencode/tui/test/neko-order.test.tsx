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
 * Round eight: reloading a session must render the transcript in
 * chronological order. The TUI asks for `order=desc` and reverses the page
 * itself; a bridge that answers ascending double-reverses the transcript and
 * puts the newest assistant reply above the oldest user message.
 */
test("reloading a session paints user then assistant in chronological order", async () => {
  await using root = await tmpdir()
  const sessionDir = join(root.path, "sessions")
  mkdirSync(sessionDir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(sessionDir, "ses_order.json"),
    JSON.stringify({
      id: "ses_order",
      agent: "build",
      directory: root.path,
      title: "order fixture",
      created: now - 1000,
      updated: now,
      idle: now,
      messages: [],
      seq: 4,
      history: [
        { id: "m1", type: "user", text: "FIRST_USER_MARKER", time: { created: now - 900 } },
        {
          id: "m2",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          content: [{ type: "text", text: "SECOND_ASSISTANT_MARKER" }],
          time: { created: now - 800, completed: now - 700 },
          finish: "stop",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
        { id: "m3", type: "user", text: "THIRD_USER_MARKER", time: { created: now - 600 } },
        {
          id: "m4",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          content: [{ type: "text", text: "FOURTH_ASSISTANT_MARKER" }],
          time: { created: now - 500, completed: now - 400 },
          finish: "stop",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
      ],
    }),
  )
  const bridge = new TuiBridge({
    modelsPath: join(root.path, "missing-models.json"),
    stateDir: sessionDir,
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
      args: { sessionID: "ses_order" },
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
    // Wait until the whole transcript is painted.
    await setup.waitForFrame(
      (frame) =>
        frame.includes("FIRST_USER_MARKER") &&
        frame.includes("SECOND_ASSISTANT_MARKER") &&
        frame.includes("THIRD_USER_MARKER") &&
        frame.includes("FOURTH_ASSISTANT_MARKER"),
      { maxPasses: 200 },
    )
    const lines = setup.captureCharFrame().split("\n")
    const row = (marker: string) => lines.findIndex((line) => line.includes(marker))
    const first = row("FIRST_USER_MARKER")
    const second = row("SECOND_ASSISTANT_MARKER")
    const third = row("THIRD_USER_MARKER")
    const fourth = row("FOURTH_ASSISTANT_MARKER")
    // Chronological on screen: m1 above m2 above m3 above m4.
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
    expect(third).toBeLessThan(fourth)
  } finally {
    setup.renderer.destroy()
    await task
    await bridge.close()
  }
}, 30000)
