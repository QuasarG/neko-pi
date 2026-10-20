# opencode TUI Port: Pi-Backed Frontend (WIP)

Date: 2026-10-20
Status: vendor complete + install green; bridge + launcher next

## Decision (user-directed)

Port the **actual opencode TUI** (not a lookalike) onto pi's backend. The
opencode frontend runs as-is in Bun; a Node bridge process implements the
opencode HTTP+SSE protocol surface on top of pi's agent core.

## Verified facts driving the design

- opencode TUI is a **client**: all data flows through `@opencode/client`
  (`createClientConnection` / `createData`, solid stores fed by SSE events).
  Zero data layer lives in the TUI itself.
- Coupling audit of `packages/tui/src`:
  - `@opencode/core` (15 MB backend core): **one import** (`util/slug`) →
    vendored as a mini package with just that file.
  - `@opencode/ui` (12 MB): only `audio/*.mp3` imports → mini package with
    assets only.
  - Real vendor set: tui, client, protocol, schema, theme, util, latex,
    merman, plugin, simulation, ai, httpapi-codegen (~12 MB, MIT).
- pnpm `catalog:` refs were resolved to concrete versions (opentui 0.6.6,
  effect 4.0.1, solid-js 1.9.15, …) — see git history of this spec.
- Bun 1.4.3 installed at `~/.bun/bin/bun` (user-level). Vendor workspace at
  `vendor/opencode/` with isolated linker; `bun install` green.
  **Trap hit once**: without `vendor/opencode/package.json`, bun walks up and
  installs into the pi root node_modules (npm tree). Always ensure the vendor
  root package.json exists before running bun there.
- TUI entry: `run(TuiInput)` in `tui/src/app.tsx:209`. Boot needs:
  `app {name, version, channel}`, `server {endpoint: {url, headers?}}`,
  `args`, `config {get()}`, `packages` (PackageSource), optional
  updater/handoff. First HTTP calls observed in boot: `file.list` (or
  `location.get` fallback) to resolve cwd location.
- pi side (from recon): use `RpcClient` from
  `@earendil-works/pi-coding-agent` (spawn `--mode rpc`, JSONL stdio) or
  in-process `createAgentSession` + `AgentSessionRuntime`. Events:
  `message_update` carries `assistantMessageEvent` deltas
  (text_delta / thinking_delta / toolcall_*); `agent_settled` bounds a run;
  `get_entries(since)` does incremental history pulls. No session-list RPC —
  scan the session dir via `SessionManager` on the bridge side.

## Architecture

```
neko-pi ui ──▶ bridge (Node, in pi workspace)          bun vendor/opencode
             │  HTTP+SSE @opencode/protocol subset     ┌──────────────────┐
             │  /event  /session/:id/prompt  ...       │ @opencode/tui    │
             └──────────── 127.0.0.1:PORT ◀────────────│ (unmodified)     │
                        (spawn + env URL)              └──────────────────┘
```

- Bridge = new package `packages/ui-bridge`: HTTP server translating the
  opencode protocol subset to `RpcClient` calls; maps pi events → opencode
  message/parts model (step-start/text/reasoning/tool parts with status).
- Launcher = `neko-pi ui` subcommand: start bridge, spawn bun with a thin
  entry (`vendor/opencode/tui/src/pi-main.tsx`) that builds `TuiInput` and
  calls `run`, wired to the bridge URL.
- Persona pack stays intact: identity enters via system prompt (pi side);
  the sidebar/avatar work from earlier milestones carries over later.

## Remaining work (next session)

1. Enumerate the exact endpoint subset the TUI hits during boot (proxy a
   real opencode server or instrument `OpenCode.make` with a logging fetch).
2. Bridge skeleton: `/event` SSE + config/location/session/models stubs →
   boot the TUI against stub data.
3. Real mapping: pi entries ↔ opencode parts; prompt/abort round-trips.
4. Session list: scan `~/.pi/agent/sessions` into opencode session shapes.
5. Kill switch: `neko-pi` keeps the current pi-tui; `neko-pi ui` opts in.
