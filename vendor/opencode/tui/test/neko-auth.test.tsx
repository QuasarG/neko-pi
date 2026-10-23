import { expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createTestRenderer } from "@opentui/core/testing"
import { run } from "../src/app"
import { tmpdir } from "./fixture/fixture"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"

/**
 * Round five: the provider login panel renders against the real bridge,
 * starts a login through the HTTP endpoint, and auth events (device codes)
 * still arrive after the panel itself is replaced — the listener lives in the
 * always-mounted NekoUiRequests component, not the panel.
 */
test("/connect lists providers, starts logins, and shows auth events after the panel closes", async () => {
  await using root = await tmpdir()
  const authCalls: Array<{ provider: string; type: string }> = []
  const demoModel = {
    id: "demo-model",
    name: "Demo Model",
    provider: "demo",
    contextWindow: 100000,
    maxTokens: 4096,
    input: ["text"],
    reasoning: false,
  }
  const bridge = new TuiBridge({
    modelsPath: join(root.path, "missing-models.json"),
    onLog: () => {},
    modelRuntime: {
      getAllModels: () => [demoModel],
      getAvailableSnapshot: () => [demoModel],
      hasConfiguredAuth: (provider: string) => provider === "demo",
    },
    auth: {
      login: async (provider, type) => {
        authCalls.push({ provider, type })
        return { ok: true }
      },
      logout: async () => {},
    },
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
    await setup.waitForFrame((frame) => frame.includes("Ask anything"))
    // Open the provider panel with the real slash command.
    await setup.mockInput.typeText("/connect")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("模型连接") && frame.includes("demo") && frame.includes("已连接"))
    // Keyboard-only entry: the first provider is selected; enter opens the
    // action menu without any mouse involvement.
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("登录 · API Key"))
    // Esc from the action menu returns to the provider list, and the menu
    // is reachable again afterwards (no dead-end state).
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => frame.includes("选择提供商") && frame.includes("demo"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("登录 · API Key"))
    // Confirm the first action: the bridge's auth runtime is invoked.
    setup.mockInput.pressEnter()
    await setup.waitForFrame(() => authCalls.length === 1)
    expect(authCalls[0]).toEqual({ provider: "demo", type: "api_key" })
    // A device code event still lands after the menu replaced the panel:
    // the listener is mounted at app level, not inside the dialog.
    bridge.publish({
      id: "evt_auth_test",
      created: Date.now(),
      type: "neko.auth.event",
      data: {
        provider: "demo",
        event: { type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" },
      },
    })
    await setup.waitForFrame((frame) => frame.includes("ABCD-1234") && frame.includes("设备码"))
    // Confirm copies through the TUI clipboard service; the success toast
    // appears only after the write resolved (navigator.clipboard does not
    // exist under bun — a silent success here would be the old bug).
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) => frame.includes("设备码已复制") || frame.includes("复制失败"),
      { maxPasses: 100 },
    )
    expect(setup.captureCharFrame()).not.toContain("复制失败")
    // The dialog closes only after the copy resolved: by the time the
    // success toast is up, the code dialog itself is gone.
    await setup.waitForFrame((frame) => !frame.includes("ABCD-1234"))
    expect(setup.captureCharFrame()).toContain("设备码已复制")
    // The secret input channel masks as it types: bullets grow, the typed
    // value never appears on screen.
    bridge.registerUiRequest({
      kind: "input",
      title: "demo API Key",
      secret: true,
      message: "请输入 demo 的 API Key",
      placeholder: "paste key",
    })
    await setup.waitForFrame((frame) => frame.includes("敏感输入"))
    await setup.mockInput.typeText("sk-super-secret")
    await setup.waitForFrame((frame) => frame.includes("return 确认"))
    const after = setup.captureCharFrame()
    expect(after).not.toContain("sk-super-secret")
    expect(after).not.toContain("crashed")
  } finally {
    setup.renderer.destroy()
    await task
    await bridge.close()
  }
}, 20000)
