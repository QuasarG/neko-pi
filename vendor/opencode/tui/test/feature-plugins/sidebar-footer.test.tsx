import { expect, test } from "bun:test"
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { run } from "../../src/app"
import { createPiConfig } from "../../src/pi-config"
import { wordmark } from "../../src/logo"
import { tmpdir } from "../fixture/fixture"
import { TuiBridge } from "../../../../../packages/coding-agent/src/modes/tui-bridge/server"

test("generated wordmark stays aligned at both terminal scales", () => {
  for (const scale of [1, 2]) {
    const lines = wordmark("NEKO-PI", scale)
    expect(lines).toHaveLength(7)
    expect(new Set(lines.map((line) => line.length)).size).toBe(1)
    expect(lines[0].length).toBe(41 * scale)
  }
  expect(() => wordmark("?", 1)).toThrow()
})

for (const [width, height] of [[120, 40], [80, 24], [44, 20]]) {
  test(`Neko home and keyboard details work at ${width}x${height}`, async () => {
    await using root = await tmpdir()
    const host = createPiConfig(join(root.path, "tui.json"))
    await host.update((draft) => { draft.animations = false })
    const persona = { name: "Neko", identityReady: true, voiceReady: true, memoryFiles: 2, lintConfigured: true,
      ...(process.env.NEKO_CAPTURE_AVATAR ? { avatarPath: process.env.NEKO_CAPTURE_AVATAR } : {}) }
    const bridge = new TuiBridge({ modelsPath: join(root.path, "missing.json"), onLog: () => {}, personaStatus: () => persona })
    const port = await bridge.listen()
    const setup = await createTestRenderer({ width, height, kittyKeyboard: true })
    await setup.renderer.setupTerminal()
    setup.renderer.start()
    const ready = Promise.withResolvers<void>()
    const task = Effect.runPromise(run({
      app: { name: "neko-pi", version: "test", channel: "test", persona },
      server: { endpoint: { url: `http://127.0.0.1:${port}` } }, args: {}, config: host,
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }), log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: root.path })), Effect.provide(FileSystem.layerNoop({}))))
    const capture = async (name: string) => {
      if (!process.env.NEKO_CAPTURE_DIR) return
      await mkdir(process.env.NEKO_CAPTURE_DIR, { recursive: true })
      const frame = setup.captureSpans()
      await writeFile(join(process.env.NEKO_CAPTURE_DIR, `${name}.json`), JSON.stringify({
        ...frame, lines: frame.lines.map((line) => ({ ...line, spans: line.spans.map((span) => ({
          ...span, fg: span.fg.toInts(), bg: span.bg.toInts(),
        })) })),
      }))
      await writeFile(join(process.env.NEKO_CAPTURE_DIR, `${name}.txt`), setup.captureCharFrame())
    }
    try {
      await ready.promise
      await setup.waitForFrame((frame) => frame.includes("Ask anything"))
      expect(setup.renderer.root.findDescendantById("neko.avatar")).toBeUndefined()
      const frame = setup.captureCharFrame()
      expect(frame).not.toContain("OpenCode")
      expect(frame).not.toContain("Getting started")
      if (width >= 110) {
        expect(frame).toContain("身份包就绪")
        expect(frame).toContain("运行记忆 2 条")
      } else expect(frame).not.toContain("身份包就绪")
      await capture(`home-${width}`)
      await host.update((draft) => { draft.animations = true })
      await Bun.sleep(100)
      const logo = setup.renderer.root.findDescendantById("neko.wordmark")!
      expect(logo.width).toBeLessThanOrEqual(41)
      expect(logo.height).toBeLessThanOrEqual(4)
      const before = JSON.stringify(setup.captureSpans())
      await setup.mockMouse.moveTo(logo.x + 3, logo.y + Math.min(1, logo.height - 1))
      await setup.waitForFrame(() => JSON.stringify(setup.captureSpans()) !== before)
      if (width >= 46) {
        const hovered = JSON.stringify(setup.captureSpans().lines.slice(logo.y, logo.y + logo.height))
        await setup.waitForFrame(() => JSON.stringify(setup.captureSpans().lines.slice(logo.y, logo.y + logo.height)) !== hovered)
      }
      await capture(`hover-${width}`)
      await host.update((draft) => { draft.animations = false })
      await Bun.sleep(100)
      const staticHover = JSON.stringify(setup.captureSpans().lines.slice(logo.y, logo.y + logo.height))
      await Bun.sleep(140)
      expect(JSON.stringify(setup.captureSpans().lines.slice(logo.y, logo.y + logo.height))).toBe(staticHover)
      await setup.mockMouse.moveTo(0, 0)
      await setup.mockInput.typeText("/neko")
      setup.mockInput.pressEnter()
      const details = await setup.waitForFrame((value) => value.includes("Neko 的状态"))
      expect(details).toContain("身份包")
      expect(details).not.toContain("OpenCode")
      await capture(`details-${width}`)
    } finally {
      setup.renderer.destroy()
      await task
      await bridge.close()
    }
  })
}
