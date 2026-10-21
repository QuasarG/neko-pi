import { expect, test } from "bun:test"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createPiConfig } from "../src/pi-config"
import { settings } from "../src/component/dialog-config"
import { tmpdir } from "./fixture/fixture"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { run } from "../src/app"
import { TuiBridge } from "../../../../packages/coding-agent/src/modes/tui-bridge/server"

test("every settings row persists its changed value across config instances", async () => {
  await using root = await tmpdir()
  const path = join(root.path, "tui.json")
  const host = createPiConfig(path)
  for (const setting of settings) {
    const next = setting.values?.find((value) => value !== setting.default) ??
      (setting.step ? Number(setting.default) + setting.step : "catppuccin")
    const changed = await host.update((draft) => {
      let parent = draft
      for (const key of setting.path.slice(0, -1)) parent = parent[key] ??= {}
      parent[setting.path.at(-1)!] = next
    })
    const restored = await createPiConfig(path).get()
    const lookup = (value: unknown) => setting.path.reduce<unknown>((current, key) => {
      if (!current || typeof current !== "object") return undefined
      return (current as Record<string, unknown>)[key]
    }, value)
    expect(lookup(changed)).toEqual(next)
    expect(lookup(restored)).toEqual(next)
  }
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ terminal: { copy: "manual" } })
})

test("concurrent updates preserve other settings and unknown fields", async () => {
  await using root = await tmpdir()
  const path = join(root.path, "tui.json")
  await writeFile(path, JSON.stringify({ $schema: "custom-schema", terminal: { copy: "manual" } }))
  await Promise.all([
    createPiConfig(path).update((draft) => { draft.mouse = false }),
    createPiConfig(path).update((draft) => { draft.animations = true }),
  ])
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    $schema: "custom-schema", mouse: false, animations: true, terminal: { copy: "manual" },
  })
})

test("invalid existing files and invalid updates are not overwritten", async () => {
  await using root = await tmpdir()
  const path = join(root.path, "tui.json")
  await writeFile(path, "{broken")
  await expect(createPiConfig(path).update((draft) => { draft.mouse = false })).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("{broken")
  await writeFile(path, "{}")
  await expect(createPiConfig(path).update((draft) => { draft.terminal = { copy: "invalid" } })).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("{}")
})

test("settings arrow keys update copy behavior and other controls in the real TUI", async () => {
  await using root = await tmpdir()
  const host = createPiConfig(join(root.path, "tui.json"))
  await host.update((draft) => { draft.animations = false })
  const bridge = new TuiBridge({ modelsPath: join(root.path, "missing.json"), onLog: () => {} })
  const port = await bridge.listen()
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const task = Effect.runPromise(run({
    app: { name: "test", version: "test", channel: "test" },
    server: { endpoint: { url: `http://127.0.0.1:${port}` } }, args: {}, config: host,
    packages: { prepare: async () => ({ directory: "" }) },
    terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
    log: () => {},
  }).pipe(Effect.provide(Global.layerWith({ state: root.path })), Effect.provide(FileSystem.layerNoop({}))))
  try {
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("Ask anything"))
    await setup.mockInput.typeText("/settings")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Settings"))
    await setup.mockInput.typeText("copy")
    await setup.waitForFrame((frame) => frame.includes("Copy behavior"))
    setup.mockInput.pressArrow("left")
    await setup.waitForFrame((frame) => frame.includes("manual"))
    expect((await host.get()).terminal?.copy).toBe("manual")
    setup.mockInput.pressArrow("right")
    await setup.waitForFrame((frame) => frame.includes("select") && !frame.includes("manual"))
    expect((await createPiConfig(host.path!).get()).terminal?.copy).toBe("select")
    let previous = "copy"
    for (const [query, label] of [["Animations", "on"], ["Scroll speed", "3.25"], ["Indicators", "always show numbers"]]) {
      setup.mockInput.pressKey("END")
      for (const _ of previous) setup.mockInput.pressBackspace()
      await setup.mockInput.typeText(query)
      await setup.waitForFrame((frame) => frame.includes(query))
      setup.mockInput.pressArrow("right")
      await setup.waitForFrame((frame) => new RegExp(`${query}\\s+${label.replace(".", "\\.")}`).test(frame))
      previous = query
    }
    expect(await createPiConfig(host.path!).get()).toMatchObject({
      animations: true, scroll: { speed: 3.25 }, tabs: { indicators: "numbers" },
    })
  } finally {
    setup.renderer.destroy()
    await task
    await bridge.close()
  }
})
