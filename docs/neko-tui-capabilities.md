# neko-pi frontend capabilities (native pi TUI)

- Date: 2026-10-24 (round 26 de-bridge; see the [remaining-work log](superpowers/tasks/2026-10-23-neko-pi-remaining-work-todo.md) 5.6).
- Architecture: the opencode bridge layer and vendored frontend were deleted this round. Interactive `neko-pi` runs pi's built-in TUI (`packages/tui`) directly; models, auth, thinking levels and session management all use pi's native capabilities.

## Models and identity (native pi)

| Capability | Status | Notes |
| --- | --- | --- |
| Model catalog | works | pi builtin provider catalog (zai-coding-cn, deepseek, etc) with thinkingLevelMap, costs and endpoint adapters; `--list-models` and `/model` |
| Default model | works | settings.json `defaultProvider` + `defaultModel` (bare model id, no provider prefix); a malformed pair silently falls back to the first available model |
| Auth | works | `/login <provider>` and `neko-pi login` (api-key / device flow, native pi); credentials in `~/.neko_pi/auth.json` |
| Thinking levels | works | `/thinking` + Ctrl+T cycling; levels come from the builtin `thinkingLevelMap` (e.g. glm-5.3-flash: low/high/max), clamped by pi |
| Persona | works | `~/.neko_pi/persona/` (identity/voice/manifest/theme); boot banner confirms "Persona loaded"; re-read per message by the runtime-context extension |

## Sessions and messages (native pi + extensions)

| Capability | Status | Notes |
| --- | --- | --- |
| Tree / fork / resume | works | `/tree`, `/fork`, `--resume`, `/import` |
| Compaction | works | `/compact`; compact resets memory receipts, so the next message re-injects full memory |
| Export | works | `/export` (HTML/JSONL) |
| Stats | works | `/session` (messages/tokens/cost/cache hits) |
| Edit and resend | works | `/edit [n]` truncates the nth-from-last user turn, rebuilds the transcript, and refills the composer (injections stripped); running sessions refuse |
| Steering / follow-ups | works | native pi steering (Esc) and queueing |

## neko-specific (extension layer, frontend-agnostic)

| Capability | Status | Notes |
| --- | --- | --- |
| Six-book memory | works | writes through MemoryChannel (versions/tombstones/caps); receipt-gated injection; tool-boundary sweep + auto-steer |
| Injected-context marker | works | user bubbles show only the human text; trailing context blocks collapse to a one-line summary (wall time, activity, memory versions, continuity), expandable (`core/injected-context.ts`) |
| Response stats | works | per completed response: duration, out/in/think tokens, tok/s (skips <250ms) |
| /context audit | works | inline panel: persona pack, both memory scopes (version/records/bytes + receipt state), continuity freshness, outfit, recent activity |
| Wardrobe / outfit | works | `wardrobe` tool (list/add/remove/lock/wear) + 6h idle reselect; outfit description injected per message |
| Continuity note | works | `continuity_update` tool; forced persona checkpoint every 3rd user query per session; content-hash-gated injection; 6h expiry |
| Skills | works | `~/.neko_pi/skills/` (dress-sense, intimacy, memory-hygiene, legacy-memory-migration, neko-pi-dev, session-workflow); listed in the boot banner |
| stylebank | works | builtin extension (`extensions/stylebank`); see the runtime doc |

## Known limits (honest list)

- Real-subscription OAuth browser flow not verified end-to-end (no real credentials; api-key flow verified on a real machine).
- Upstream GLM content moderation (e.g. 1301 rejections) is provider policy: switch to deepseek or a local model; the product layer only presents it.
- Bridge-era sessions (bridge projection JSON) are no longer read by the frontend; native JSONL sessions are fully compatible.
