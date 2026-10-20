/**
 * Thin entry that boots the vendored opencode TUI against a neko-pi bridge.
 *
 * Usage (spawned by `neko-pi ui`):
 *   PI_BRIDGE_URL=http://127.0.0.1:PORT bun src/pi-main.tsx [sessionID?]
 *
 * Everything UI-side is stock; only the connection target differs.
 */

import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { run } from "./app.tsx"

const url = process.env.PI_BRIDGE_URL
if (!url) {
  console.error("PI_BRIDGE_URL is required (set by `neko-pi ui`)")
  process.exit(1)
}

const sessionID = process.argv[2]

const input = {
  app: {
    name: "neko-pi",
    version: "1.3.0",
    channel: "stable",
  },
  server: {
    endpoint: { url },
  },
  args: {
    ...(sessionID ? { sessionID } : {}),
  },
  config: {
    get: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
  },
  packages: {
    prepare: () => Promise.resolve(),
  },
  log: (level: string, message: string) => {
    if (level === "error" || level === "warn") console.error(`[tui:${level}] ${message}`)
  },
}

await Effect.runPromise(run(input as any).pipe(Effect.provide(LayerNode.compile(Global.node) as any)))
