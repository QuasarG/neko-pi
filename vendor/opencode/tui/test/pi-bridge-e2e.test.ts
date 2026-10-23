import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { createTestRenderer, type CapturedFrame } from "@opentui/core/testing"
import { Global } from "@opencode/util/global"
import { createRoot } from "solid-js"
import { createData } from "@opencode/client/solid"
import { OpenCode } from "@opencode/client"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"
import { run } from "../src/app"
import { tmpdir as createState } from "./fixture/fixture"
import type { AgentSessionEvent } from "../../../../packages/coding-agent/src/core/agent-session"

// End-to-end traversal of the vendored TUI against the real bridge: session
// tree clicks across projects (U01), tab reuse (U02), background runs (U03),
// rename/archive reflection (U04), 404 recovery (U05) and interrupt/model
// wiring (U07).

interface Harness {
  bridge: TuiBridge
  port: number
  setup: Awaited<ReturnType<typeof createTestRenderer>>
  task: Promise<void>
  requests: string[]
  agents: Map<string, { cwds: string[]; prompts: string[]; setModels: string[]; aborted: number }>
  gates: Array<() => void>
  /** Prompt texts that must wait for an explicit gate release. */
  held: Set<string>
  dispose: () => Promise<void>
}

async function bootE2E(sessionID?: string): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "pi-e2e-"))
  const dirA = join(home, "alpha-service")
  const dirB = join(home, "beta-service")
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const state = await createState()
  const modelsPath = join(state.path, "models.json")
  writeFileSync(modelsPath, JSON.stringify({ providers: { demo: { models: [{ id: "e2e-model" }, { id: "pick-model" }] } } }))
  const requests: string[] = []
  const agents = new Map<string, { cwds: string[]; prompts: string[]; setModels: string[]; aborted: number }>()
  const gates: Array<() => void> = []
  const held = new Set<string>()
  const bridge = new TuiBridge({
    defaultDirectory: dirA,
    modelsPath,
    stateDir: join(state.path, "bridge"),
    /* the harness disposes the state directory in dispose() */
    onLog: (line) => requests.push(line),
    personaStatus: () => ({ name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 1, lintConfigured: true }),
    createAgent: async (cwd, model, sessionID2) => {
      const entry = agents.get(sessionID2!) ?? { cwds: [], prompts: [], setModels: [], aborted: 0 }
      entry.setModels.push(model ? `${model.providerID}/${model.id}` : "none")
      agents.set(sessionID2!, entry)
      entry.cwds.push(cwd)
      let listener: ((event: AgentSessionEvent) => void) | undefined
      return {
        subscribe(fn) {
          listener = fn
          return () => {
            listener = undefined
          }
        },
        async prompt(text: string) {
          entry.prompts.push(text)
          if (!held.has(text)) {
            await new Promise((resolve) => setTimeout(resolve, 25))
          } else {
            await new Promise<void>((resolve) => {
              gates.push(resolve)
            })
          }
          const message = {
            role: "assistant" as const,
            api: "openai-completions" as const,
            provider: "demo",
            model: "e2e-model",
            timestamp: Date.now(),
            content: [{ type: "text" as const, text: `reply:${text}` }],
            stopReason: "stop" as const,
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          }
          listener?.({ type: "message_start", message })
          listener?.({ type: "message_end", message })
        },
        async setModel(next) {
          entry.setModels.push(`${next.providerID}/${next.id}`)
        },
        async abort() {
          entry.aborted++
          for (const resolve of gates.splice(0)) resolve()
        },
        async waitForIdle() {},
        dispose() {},
      }
    },
  })
  const port = await bridge.listen()
  const post = async (path: string, body: unknown) =>
    (await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()
  await post("/api/session", { id: "ses_u1", title: "Alpha 会话", location: { directory: dirA } })
  await post("/api/session", { id: "ses_u2", title: "Beta 会话", location: { directory: dirB } })

  const setup = await createTestRenderer({ width: 150, height: 44, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const task = Effect.runPromise(
    run({
      app: { name: "neko-pi", version: "test", channel: "test", nekoEndpoint: `http://127.0.0.1:${port}`, persona: { name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 1, lintConfigured: true } },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: sessionID ? { sessionID } : {},
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  await ready.promise
  return {
    bridge,
    port,
    setup,
    task,
    requests,
    agents,
    gates,
    held,
    dispose: async () => {
      for (const resolve of gates.splice(0)) resolve()
      setup.renderer.destroy()
      await task
      await bridge.close()
      rmSync(home, { recursive: true, force: true })
      await state[Symbol.asyncDispose]()
    },
  }
}

/** Type with retries: the composer remounts once during location/session boot. */
async function type(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      setup.mockInput.typeText(text)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`could not type "${text}": composer never settled`)
}

/** Click the row showing `label` until the location footer switches to `dir`. */
async function clickRowUntil(e2e: Harness, label: string, dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await untilFrame(e2e.setup, (f) => f.includes("ctrl+p commands"))
    const frame = e2e.setup.captureSpans()
    const target = findText(frame, label)
    if (!target) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    await e2e.setup.mockMouse.click(target.x, target.y)
    try {
      await untilFrame(e2e.setup, (f) => f.includes("ctrl+p commands") && f.includes(dir), 4000)
      return
    } catch {
      // Click landed on a collapsing group or missed the row; retry.
    }
  }
  throw new Error(`could not open session row "${label}" into ${dir}`)
}

async function submit(e2e: Harness, session: string, text: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${e2e.port}/api/session/${session}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, delivery: "steer" }),
  })
  expect(response.status).toBe(200)
}

/** Frame polling without the renderer's internal wait cap. */
async function untilFrame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(setup.captureCharFrame())) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  const tail = setup.captureCharFrame().split("\n").filter((line) => line.trim().length > 0).slice(-8).join("\n")
  throw new Error(`frame condition not met in time; last frame tail:\n${tail}`)
}

async function until(condition: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("condition not met in time")
}

/** Locate a cell inside a rendered span containing `needle`. */
function findText(frame: CapturedFrame, needle: string): { x: number; y: number } | undefined {
  for (const [y, line] of frame.lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      if (span.text.includes(needle)) return { x: x + 1, y }
      x += span.width
    }
  }
  return undefined
}

test("U01: clicking another project's session switches location and delivery target", async () => {
  const e2e = await bootE2E("ses_u1")
  try {
    await untilFrame(e2e.setup, (frame) => frame.includes("Alpha 会话") && frame.includes("Beta 会话"))
    // Group labels show readable project names for same-shaped basenames.
    await untilFrame(e2e.setup, (frame) => frame.includes("alpha-service") && frame.includes("beta-service"))
    await clickRowUntil(e2e, "Beta 会话", "beta-service")
    // The cross-project open re-boots the client's location context; delivery
    // to the switched session reaches the backend bound to beta's cwd.
    await submit(e2e, "ses_u2", "for beta")
    await until(() => (e2e.agents.get("ses_u2")?.prompts.length ?? 0) === 1)
    expect(e2e.agents.get("ses_u2")!.cwds[0]).toContain("beta-service")
  } finally {
    await e2e.dispose()
  }
}, 30000)

test("U02: clicking the already-open session's row reuses it instead of duplicating", async () => {
  const e2e = await bootE2E("ses_u1")
  try {
    await untilFrame(e2e.setup, (frame) => frame.includes("Alpha 会话"))
    // Click the open session's own row; it reuses the tab and keeps alpha.
    await clickRowUntil(e2e, "Alpha 会话", "alpha-service")
    // Still exactly one Alpha session, and delivery keeps working.
    await submit(e2e, "ses_u1", "still here")
    await until(() => (e2e.agents.get("ses_u1")?.prompts.length ?? 0) === 1)
    // Reuse, not duplication: exactly one session per original ID.
    const sessions = await (await fetch(`http://127.0.0.1:${e2e.port}/api/session`)).json()
    const ids = sessions.data.map((s: { id: string }) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(["ses_u1", "ses_u2"]))
  } finally {
    await e2e.dispose()
  }
}, 30000)

test("U03: a run left behind a tab switch finishes into its own session only", async () => {
  const e2e = await bootE2E("ses_u1")
  try {
    await untilFrame(e2e.setup, (frame) => frame.includes("Alpha 会话") && frame.includes("Beta 会话"))
    e2e.held.add("slow beta question")
    // Open Beta, start a gated run there, then switch back to Alpha.
    await clickRowUntil(e2e, "Beta 会话", "beta-service")
    await submit(e2e, "ses_u2", "slow beta question")
    await until(() => (e2e.agents.get("ses_u2")?.prompts.length ?? 0) === 1)
    await clickRowUntil(e2e, "Alpha 会话", "alpha-service")
    // Alpha keeps working while Beta's turn is still gated.
    await submit(e2e, "ses_u1", "quick alpha")
    await until(() => (e2e.agents.get("ses_u1")?.prompts.length ?? 0) === 1)
    await until(() => e2e.requests.some((line) => line.includes("POST /api/session/ses_u1/prompt")))
    // Release Beta's gate: its result lands in Beta's history only.
    for (const resolve of e2e.gates.splice(0)) resolve()
    await until(() => (e2e.agents.get("ses_u2")?.prompts.length ?? 0) === 1)
    // The gated reply lands asynchronously after the gate opens: poll both
    // histories until each turn's own reply is present.
    let betaSeen = false
    let alphaSeen = false
    for (let i = 0; i < 150 && !(betaSeen && alphaSeen); i++) {
      const betaHistory = await (await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u2/message`)).json()
      const alphaHistory = await (await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u1/message`)).json()
      betaSeen = JSON.stringify(betaHistory.data).includes("reply:slow beta question")
      alphaSeen = JSON.stringify(alphaHistory.data).includes("reply:quick alpha")
      expect(JSON.stringify(alphaHistory.data)).not.toContain("slow beta question")
      if (!(betaSeen && alphaSeen)) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(betaSeen).toBe(true)
    expect(alphaSeen).toBe(true)
  } finally {
    await e2e.dispose()
  }
}, 30000)

test("U04: rename and archive through the API reflect immediately in the tree", async () => {
  const e2e = await bootE2E("ses_u1")
  try {
    await e2e.setup.waitForFrame((frame) => frame.includes("Beta 会话"))
    const patch = await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "改名后的会话" }),
    })
    expect(patch.status).toBe(204)
    await untilFrame(e2e.setup, (frame) => frame.includes("改名后的会话"))
    const archive = await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    })
    expect(archive.status).toBe(204)
    await untilFrame(e2e.setup, (frame) => !frame.includes("改名后的会话"))
  } finally {
    await e2e.dispose()
  }
}), 30000

test("U05: a missing session shows a recoverable error, never fake data or a crash", async () => {
  const e2e = await bootE2E("ses_missing")
  try {
    const frame = await e2e.setup.waitForFrame((f) => f.includes("Session not found"))
    expect(frame).not.toContain("crashed")
    expect(frame).not.toContain("Getting started")
    // The banner's action button recovers into a working composer.
    await e2e.setup.mockMouse.click(144, 2)
    await e2e.setup.waitForFrame((f) => !f.includes("Session not found") && f.includes("ctrl+p commands"))
  } finally {
    await e2e.dispose()
  }
}), 30000

test("U07: model selection drives the backend and interrupt aborts the running turn", async () => {
  const e2e = await bootE2E("ses_u1")
  try {
    await untilFrame(e2e.setup, (f) => f.includes("ctrl+p commands") && f.includes("alpha-service"))
    e2e.held.add("slow one")
    const pick = await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u1/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID: "demo", id: "pick-model" } }),
    })
    expect(pick.status).toBe(204)
    await submit(e2e, "ses_u1", "use the picked model")
    await until(() => (e2e.agents.get("ses_u1")?.setModels.length ?? 0) >= 2)
    // The picked model reached the backend agent for this session.
    expect(e2e.agents.get("ses_u1")!.setModels.at(-1)).toBe("demo/pick-model")
    // A gated turn is interrupted: abort reaches the backend (the Escape key
    // routes to the same interrupt endpoint and is covered by pi-bridge).
    await submit(e2e, "ses_u1", "slow one")
    await until(() => (e2e.agents.get("ses_u1")?.prompts.length ?? 0) === 2)
    const interrupted = await fetch(`http://127.0.0.1:${e2e.port}/api/session/ses_u1/interrupt`, { method: "POST" })
    expect(interrupted.status).toBe(200)
    await until(() => (e2e.agents.get("ses_u1")?.aborted ?? 0) >= 1)
    expect(e2e.requests.filter((line) => line.startsWith("MISSING"))).toEqual([])
  } finally {
    await e2e.dispose()
  }
}, 30000)
