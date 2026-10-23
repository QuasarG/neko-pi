import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { Effect, FileSystem, Schema } from "effect"
import { createTestRenderer } from "@opentui/core/testing"
import { Global } from "@opencode/util/global"
import { createRoot } from "solid-js"
import { createData } from "@opencode/client/solid"
import { OpenCode } from "@opencode/client"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"
import { run } from "../src/app"
import { tmpdir as createState } from "./fixture/fixture"
import type { AgentSessionEvent } from "../../../../packages/coding-agent/src/core/agent-session"

test("bridge boot and prompt responses satisfy the composer contracts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-bridge-"))
  mkdirSync(join(home, ".pi", "agent"), { recursive: true })
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({
    providers: { demo: { models: [{ id: "demo-model" }] } },
  }))
  const bridge = new TuiBridge({ defaultDirectory: home, modelsPath: join(home, ".pi", "agent", "models.json"), onLog: () => {} })
  const port = await bridge.listen()
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}/api/${path}`)).json()
  const post = async (path: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).json()
  try {
    Schema.decodeUnknownSync(Location.PublicInfo)(await get("location"))
    const agents = Schema.decodeUnknownSync(Location.response(Schema.Array(Agent.Info)))(await get("agent"))
    expect(agents.data[0]?.id).toBe("build")
    const models = Schema.decodeUnknownSync(Location.response(Schema.Array(Model.Info)))(await get("model"))
    expect(models.data[0]?.id).toBe("demo-model")
    expect(models.data[0]?.enabled).toBe(true)
    const selected = Schema.decodeUnknownSync(Location.response(Model.Info))(await get("model/default"))
    expect(selected.data.id).toBe("demo-model")
    const created = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(await post("session", {
      id: "ses_bridge_test", agent: "build", model: { providerID: "demo", id: "demo-model" }, location: { directory: home },
    }))
    expect(created.data.id).toBe("ses_bridge_test")
    const admitted = Schema.decodeUnknownSync(Schema.Struct({ data: SessionInbox.User }))(await post("session/ses_bridge_test/prompt", {
      id: "msg_bridge_test", text: "hello", delivery: "steer",
    }))
    expect(admitted.data.id).toBe("msg_bridge_test")
    expect(admitted.data.payload.text).toBe("hello")
    const inbox = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionInbox.User) }))(await get("session/ses_bridge_test/inbox"))
    expect(inbox.data).toEqual([])
  } finally {
    await bridge.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("a missing session cannot poison sorting when a new session is created", async () => {
  const bridge = new TuiBridge({ modelsPath: "/nonexistent/pi-bridge-models.json", onLog: () => {} })
  const port = await bridge.listen()
  const api = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` })
  const setup = createRoot((dispose) => ({
    dispose,
    data: createData({
      api: () => api, directory: process.cwd(),
      event: { on: () => () => {}, listen: () => () => {} },
    }),
  }))
  try {
    await setup.data.session.sync("ses_previous_bridge").catch(() => {})
    const created = setup.data.session.create({ title: "New session" })
    await created.request
    expect(setup.data.session.list().map((session) => session.id)).toEqual([created.id])
    await expect(api.session.get({ sessionID: "ses_previous_bridge" })).rejects.toMatchObject({
      _tag: "SessionNotFoundError", sessionID: "ses_previous_bridge",
    })
    for (const suffix of ["/message", "/inbox", "/permission", "/form"]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/session/ses_previous_bridge${suffix}`)
      expect(response.status).toBe(404)
    }
    const active = await api.session.active()
    expect(active).toEqual({})
  } finally {
    setup.dispose()
    await bridge.close()
  }
})

test("Enter in the real TUI admits a prompt through the bridge", async () => {
  await using state = await createState()
  const modelsPath = join(state.path, "models.json")
  writeFileSync(modelsPath, JSON.stringify({ providers: { demo: { models: [{ id: "bridge-demo-model" }] } } }))
  const requests: string[] = []
  let listener: ((event: AgentSessionEvent) => void) | undefined
  const bridge = new TuiBridge({
    defaultDirectory: process.cwd(), modelsPath, onLog: (line) => requests.push(line),
    personaStatus: () => ({ name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 2, lintConfigured: true }),
    createAgent: async () => ({
      subscribe(fn) { listener = fn; return () => { listener = undefined } },
      async prompt() {
        const message = {
          role: "assistant" as const, api: "openai-completions" as const,
          provider: "demo", model: "bridge-demo-model", timestamp: Date.now(),
          content: [{ type: "text" as const, text: "Hello from the pi backend" }],
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
  const setup = await createTestRenderer({ width: 150, height: 44, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const task = Effect.runPromise(run({
    app: { name: "neko-pi", version: "test", channel: "test", nekoEndpoint: `http://127.0.0.1:${port}`, persona: {
      name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 2, lintConfigured: true,
      ...(process.env.NEKO_CAPTURE_AVATAR ? { avatarPath: process.env.NEKO_CAPTURE_AVATAR } : {}),
    } },
    server: { endpoint: { url: `http://127.0.0.1:${port}` } },
    config: { get: async () => ({ animations: false }), update: async () => ({}) },
    packages: { prepare: async () => ({ directory: "" }) },
    terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
    args: { sessionID: "ses_previous_bridge" }, log: () => {},
  }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))))
  try {
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("bridge-demo-model"))
    await setup.mockInput.typeText("/init")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("1/5 · 称呼"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("1/5 · 称呼"))
    await setup.mockInput.typeText("hello bridge")
    setup.mockInput.pressEnter()
    await setup.waitForFrame(() => requests.some((line) => /^POST \/api\/session\/[^/]+\/prompt/.test(line)))
    expect(requests.filter((line) => /^POST \/api\/session\/[^/]+\/prompt/.test(line))).toHaveLength(1)
    expect(requests.filter((line) => line.startsWith("MISSING"))).toEqual([])
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`)
    const sessions = await sessionResponse.json()
    const inboxResponse = await fetch(`http://127.0.0.1:${port}/api/session/${sessions.data[0].id}/inbox`)
    const inbox = await inboxResponse.json()
    const frame = await setup.waitForFrame((frame) => frame.includes("Hello from the pi backend"))
    expect(inbox.data).toHaveLength(0)
    expect(frame).not.toContain("crashed")
    expect(frame).not.toContain("Failed to set up session")
    expect(frame).not.toContain("Getting started")
    // The status/portrait area stays blank by requirement; /neko still reports on demand.
    expect(frame).not.toContain("运行记忆")
    if (process.env.NEKO_CAPTURE_DIR) {
      if (frame.includes("Session not found")) {
        await setup.mockMouse.click(144, 2)
        await setup.waitForFrame((value) => !value.includes("Session not found"))
      }
      await mkdir(process.env.NEKO_CAPTURE_DIR, { recursive: true })
      const captured = setup.captureSpans()
      await writeFile(join(process.env.NEKO_CAPTURE_DIR, "session-150.json"), JSON.stringify({
        ...captured, lines: captured.lines.map((line) => ({ ...line, spans: line.spans.map((span) => ({
          ...span, fg: span.fg.toInts(), bg: span.bg.toInts(),
        })) })),
      }))
    }
  } finally {
    setup.renderer.destroy()
    await task
    await bridge.close()
  }
})
