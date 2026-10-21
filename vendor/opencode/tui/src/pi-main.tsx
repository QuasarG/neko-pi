/**
 * Thin entry that boots the vendored opencode TUI against a neko-pi bridge.
 *
 * Usage (spawned by `neko-pi ui`):
 *   PI_BRIDGE_URL=http://127.0.0.1:PORT bun src/pi-main.tsx [sessionID?]
 *
 * Uses the local persona status and persisted terminal preferences.
 */

import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { run } from "./app.tsx"
import { join } from "node:path"
import { homedir } from "node:os"
import { createPiConfig } from "./pi-config"
import type { TuiApp } from "./context/runtime"

const url = process.env.PI_BRIDGE_URL
if (!url) {
  console.error("PI_BRIDGE_URL is required (set by `neko-pi ui`)")
  process.exit(1)
}

const sessionID = process.argv[2]
if (process.env.PI_BRIDGE_CWD) process.chdir(process.env.PI_BRIDGE_CWD)
const statusResponse = await fetch(`${url}/api/neko/status`)
if (!statusResponse.ok) throw new Error("Could not load Neko's identity status")
const persona = await statusResponse.json() as NonNullable<TuiApp["persona"]>

const input = {
  app: {
    name: "neko-pi",
    version: "1.3.0",
    channel: "stable",
    persona,
    nekoEndpoint: url,
  },
  server: {
    endpoint: { url },
  },
  args: {
    ...(sessionID ? { sessionID } : {}),
  },
  config: createPiConfig(join(process.env.OPENCODE_CONFIG_DIR ?? join(process.env.NEKO_PI_HOME ?? join(homedir(), ".neko_pi"), "tui"), "tui.json")),
  packages: {
    prepare: () => Promise.resolve(),
  },
  log: (level: string, message: string) => {
    if (level === "error" || level === "warn") console.error(`[tui:${level}] ${message}`)
  },
}

await Effect.runPromise(run(input as any).pipe(Effect.provide(LayerNode.compile(Global.node) as any)))
