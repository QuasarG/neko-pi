# Web and TUI parity handoff

## Goal

Bring `apps/web` to feature parity with neko-pi's interactive TUI while keeping the existing pi-web visual design. ZCode is an interaction reference only. Web operations must read and write the same native `~/.neko_pi` storage and session JSONL structure as the TUI.

## Storage and runtime

- `NEKO_PI_HOME` selects the global state directory; the default is `~/.neko_pi`.
- `NEKO_PI_SESSION_DIR` selects the native session directory when configured.
- Project configuration lives under `CONFIG_DIR_NAME` (`.neko_pi`).
- Web session operations use the local `@earendil-works/pi-*` packages and native `SessionManager` JSONL files. Do not add a Web-only transcript format.
- `apps/web` is intentionally an independent npm install, outside root workspaces. After local package changes, refresh its copied package dependencies with `npm --prefix apps/web run sync:pi`.
- Un-exported SDK helpers are loaded through `apps/web/lib/pi-sdk-internals.ts` (ADR 0006 dist-file pattern, contract-pinned by its test). Two loaders exist: the original plus `loadPiSdkSessionInternals` for session-export/bug-report helpers. Do not add package-root exports for these.

## Implemented Web behavior

The built-in command handler in `apps/web/hooks/useAgentSession.ts` covers `/settings`, `/scoped-models`, `/tree`, `/model`, `/thinking`, `/new`, `/debug`, `/export`, `/fork`, `/resume`, `/trust`, `/login`, `/logout`, `/import`, `/changelog`, `/hotkeys`, `/name`, `/session`, `/reload`, `/compact`, `/auto-compact`, `/copy`, `/clone`, and now `/share`, `/bug`, and `/quit`. `/edit`, `/undo`, `/turns`, and `/context` are provided by `apps/web/lib/neko-session-commands.ts`; bare `/mcp` opens the MCP settings panel when the native MCP command owns it.

`/share` (2026-10-30): consent dialog stating exactly what leaves the machine (full session branch JSONL including tool results/file contents, plus system prompt and tool schemas via the `pi.share` trailer), destination read from the same persisted `sessionShareDestination` setting the TUI uses, plus a no-network "download JSONL" escape hatch; uploads run server-side through the live agent session (Radius artifact first per settings, GitHub gist via `gh` fallback with viewer URL). `/bug <description>` (2026-10-30): four-step consent dialog mirroring the native flow (disclaimer → transcript include/exclude → optional model-written summary with own-provider warning → delivery naming the real gateway host), `PI_OFFLINE` blocks upload, zip delivery is a browser download, and the consent outcome is appended to the native session JSONL as the identical `pi.bug-report` custom entry (`BugReportSessionEntryData` shape) through the live session's own SessionManager. `/quit`: intercepted client-side with a platform-limitation notice; never sent to the model.

Command parity against the 28 native built-ins: all are implemented, panel-owned, or intentionally different; `/quit` is a documented platform limitation. Known secondary gaps (recorded, not implemented): `/export <path>` JSONL form, `/fork` arbitrary-message selection, `/turns` per-turn durations, `/import` argument-shape inversion, and unknown-slash-command fallthrough to the model. These live in the NEKO-WEB.md backlog.

## Extension defaults and MCP

User ruling 2026-10-30 (binding): the neko-pi TUI is the parity baseline. Do not introduce web-only capabilities beyond the approved exceptions without asking.

- Codemode remains enabled in Web (user-approved).
- pi-web built-in subagents (`Agent` tool) remain assembled but default OFF (user-approved keep).
- Removed 2026-10-30 per user ruling: the Windows "Use PowerShell" shell toggle (panel + `/api/tools/settings` arm + helpers), the project-command bash shadow extension (`createProjectCommandBashExtension`, `preferUserBashExtension`), and the read-only mode (`createReadOnlyMcpPolicyExtension` + `"read-only"` preset entry). Kept: `sanitizeProjectCommandEnvironment` (MCP transport hardening), `createProjectCommandBashOperations` (the `!`/`!!` direct-bash path), the generic tool-pin machinery, `PRESET_READ_ONLY` (subagent profiles), and the subagent MCP policy. Consequence (accepted, documented in ADR 0001): the model's bash inherits the full server environment, so `PI_WEB_PASSWORD` is readable via the model's bash — TUI-parity semantics; the #647 abort-settle grace no longer covers the model's bash (still covers `!`/`!!`).
- MCP support remains dormant with zero configured servers (empty config injected; no transport, no idle timer, no errors). Operator kill-switch `PI_WEB_DISABLE_MCP`.

`/import` validates an uploaded JSONL session and stores its original entry structure in the current native session directory. `/changelog` serves the installed pi package changelog. `/hotkeys` lists Web shortcuts. Auth commands open the Models settings UI. Session commands and sidebar/session APIs use the native storage paths.

Relevant Web integration points: `apps/web/components/AppShell.tsx`, `apps/web/components/ChatWindow.tsx`, `apps/web/hooks/useAgentSession.ts`, `apps/web/lib/neko-session-commands.ts`, `apps/web/lib/rpc-manager.ts`, `apps/web/lib/share-bug-commands.ts`, `apps/web/components/ShareDialog.tsx`, `apps/web/components/BugReportDialog.tsx`, `apps/web/app/api/sessions/[id]/{share,bug-report}/route.ts`.

## Verification state (2026-10-30)

- Full apps/web suite: tests 3233 | pass 3232 | fail 0 | skipped 1 (pre-existing platform-gated skip). The 47 failures from the pre-migration baseline are fully repaired; failure classification and fixes are in `.superpowers/sdd/WEB-TUI-HANDOFF/` (task-A/B/C reports, review packages).
- `npm --prefix apps/web run lint` clean; `npx tsc --noEmit -p apps/web/tsconfig.json` clean; root `npm run check` exit 0.
- All share/bug tests are hermetic: network `fetch` mocked, `gh` isolated behind a stub-PATH fixture (`fakeGhPath`) so no host state can trigger a real upload.
- One post-fix regression was caught and repaired during final verification (bare `/name` read the session name from a top-level field; the real GET route exposes it only at `info.name`).

## Remaining parity work

- Browser exercise of the `/share`, `/bug`, `/quit` flows (2026-10-30, live dev server): `/quit` fully verified (exact platform-limitation notice, client-side interception, never sent). Command palette lists all three commands. The no-session fallthrough (share/bug with no active session create a new session and send the text as a prompt — the documented unknown-command behavior) was verified live repeatedly. The dialogs themselves were NOT demonstrated live: the sidebar's session tree is polluted with ~18 test-residue project groups (pi-web-lifecycle-cwd-*, pi-web-debug-cwd-*, plus a pinned ghost project `/p` pointing at a nonexistent directory), leaving no healthy selectable session substrate during the smoke; dialog behavior stands on the integration suite (44 tests) plus three review passes. Cleaning that sidebar residue (native session dirs under test cwds + the `/p` pin) is a small chore for whoever touches this next. An interim blank-boot scare during the smoke was root-caused to transient HMR compile states from parallel agents live-editing apps/web — not a code defect (`.superpowers/sdd/WEB-TUI-HANDOFF/debug-blank-boot-report.md`).
- Deferred minors (next touch of these files): cross-site 403 test for the bug-report route; `bugReportFiles` member in pi-sdk-internals is loaded but unused; BugReportDialog busy label cannot distinguish "summarizing" from "uploading"; pre-cut read-only pinned sessions display as `default` in the picker (pin still enforced; consider a generic "custom/pinned" label); gist test 2 could add a throw-on-call fetch mock as belt-and-braces; missing-coverage: "Session has no name" branch.
- Subagent frontend design (next round): research complete in `.superpowers/sdd/WEB-TUI-HANDOFF/zcode-subagent-design-notes.md` — ZCode has no nesting; the neko core `subagent` tool already runs in web sessions but renders as a generic tool card (`<task-notification>` renders as raw XML). Candidate work: `neko-subagent` card renderer, background-task completion cards, depth-aware family rows; also reconcile the two concurrency knobs (`agents/settings.json` maxConcurrent vs `subagents.json` maxConcurrency) and the two frontmatter dialects over the same `agents/` dir.
- Audit keyboard actions, extension custom UI, session-tree navigation, import edge cases, and the Neko-specific memory/wardrobe/activity panels (TUI has custom-message renderers + panels that Web still lacks).
- Keep `apps/web/NEKO-WEB.md` current as implementation progresses.

## Suggested continuation

1. Finish the browser smoke once the dev server boots again; tick the NEKO-WEB.md checklist for /share, /bug, /quit.
2. Pick up the subagent frontend round from the design notes (rendering-first; keep the default-off gate).
3. Triage the deferred minors above into the next fix wave.
4. Nothing is committed; the working tree holds this round's changes plus earlier waves' fixture migration. Commit scope is the user's call.

## Phase 2 (2026-10-30 late): ZCode-referenced visual overhaul — COMPLETE

User order: bold ZCode-referenced improvements (motion + layout priority; color sophistication, no cheap high-contrast clashes), then delete test residue. Executed as three reviewed waves over `apps/web` (each: implementer subagent + review + full suite green; see `.superpowers/sdd/WEB-TUI-HANDOFF/task-{D,E,F}*`):

- Wave 1 layout: Zai-recalibrated default light/dark (near-monochrome alpha layering; muted slate accent #445c7e/#9fb5d3), radius/shadow/font-size token scales, ≥960px floating frames (chat + right panel as 12px cards, 4px gap), adaptive chat column (widens to min(72vw,1080px) when the file panel closes). `apps/web/DESIGN.md` is now the design contract.
- Wave 2 motion: `--motion-*` token ladder (120/160/200/320ms + 3 easings), unified dialog/menu/popover entrances (fade+scale+directional slide, blurred backdrops), composer dock rise, opacity-only streaming fade, `prefers-reduced-motion` cutoffs + hidden-document pause gate.
- Wave 3 polish: pixel-dot/shimmer loading vocabulary, gradient-flow hero title, context-bar waterfall, SessionSearch results restyle (top-anchor, capped stagger), accent resize-handle indicators, themed scrollbars + focus ring; streaming-fade exemption ledger (first-paint and lazy-load prepends exempt; one fix round for the prepend window timing).

Verification: full suite 3235/3234/0 fail (1 pre-existing skip) after every wave and after the final fix; `tsc` + `eslint` clean; root `npm run check` exit 0; live screenshots verified both themes (frames + palette confirmed at computed-style level; dialogs live-verified 16px/attention shadow).

Known quiet-by-design points (user taste calls, Zai-spec default kept): dark-theme frame layering is intentionally subtle (4% luminance deltas); a "presence nudge" (border alpha 0.10→0.13, canvas one step grayer, slightly stronger surface shadow) is a one-line token change if desired. Deferred minors: Firefox scrollbar progressive enhancement (2 lines), shimmer @supports gating inconsistency, session-tree row visuals remain fenced by their whitelist test (prior user ruling).

Test-residue cleanup (user-ordered, executed): 48 test sessions deleted via the app's bulk-delete route; 57 empty test dirs removed; ghost `/p` pin + 41 test projectOrder keys + fixture projectNames/sessions keys surgically removed from `pi-web-session-state.json`; webtest-dir trio (projects/continuity/activities rows) deleted from `runtime/state.sqlite` with the dev server stopped; 2 test trust grants removed; `memory/projects/webtest-dir--*` dir removed. Verified: session index = 20 real user sessions across 7 real project cwds; protect-list untouched. The `lint` MCP server fixture was removed 2026-10-31 per user order (only the user's disabled `chrome` entry remains).

## Phase 3 (2026-10-31): user-perspective coherence round — COMPLETE

User critique: injected context on the LEFT under right-aligned user bubbles = fragmentation; ugly styling; pops open with no animation; "many similar spots". Executed as three reviewed waves (Task G/H/I in `.superpowers/sdd/WEB-TUI-HANDOFF/`):

- Wave G chat-stream coherence: injected context regrouped under the bubble in the RIGHT zone (fit-content ≤85%, token chip, `pi-rise-in` animated disclosure); latent injection-leak killed (INJECTION_TAGS 5→9 in `packages/coding-agent/src/core/injected-context.ts` + sync:pi + regression tests — messages ending in wardrobe_error/runtime_compensation etc. no longer leak raw XML into bubbles); tool-call cards tokenized with grid-rows animated expansion + 1.2s pending sweep; thinking blocks tokenized (`--thinking-accent`); process-details fold animated on a rail; quote popover joins `pi-surface-in`.
- Wave H entrances & chrome: queued box, four composer-banner families (`--feedback-warning/ok/danger` quiet tokens), steering amber, system/compaction disclosures, minimap preview + lock gold, TabBar fold/unfold — no more pop-ins; module-local reduce cutoff for hashed classes.
- Wave I long tail: in-stream error/truncated banners, diff row fills/markers, all radius-6/8 orphans, follow-up indigo → accent, isCompacting reds → danger mixes, 11px → type ladder. Value-swaps only.

DESIGN.md gained principle 5 (user-perspective coherence: content belongs to its conversational side; no meaningful pop-ins; tokens only). Verification: 3236/3235/0 fail + tsc + eslint + root check exit 0; live-verified the named case on the user's real message (computed styles + animation + screenshots). Parked owner-call items: directional popover shadows, tps heat scale, radius-5/12 + font literals, `producerSummaries` zh facts localization (shared package, kept zh), CustomMessageView image radius.

## Phase 4 (2026-10-31): memory delivery diffs, tool-preset lock, poisoned-transcript fix, rebrand — COMPLETE

Four reviewed tasks (J/K/L-fix/M; reports in `.superpowers/sdd/WEB-TUI-HANDOFF/`):

- Memory delivery (J, core): record UPDATES now deliver as line diffs against a per-session snapshot cache (`memory_delivery_snapshots`, cache-not-source-of-truth, lifecycle mirrors receipts/tombstones); full-body fallback when no snapshot or diff uneconomical (LCS 4M-cell guard + 50%-byte guard). `<runtime_memory>` preamble no longer tells the model to re-read record files (baseline copy is authoritative; updates are diffs to apply mentally). memory_write description: anchor appends sanctioned via the tool; shell edits forbidden (bypass versioning/receipts → redundant redelivery).
- Tool presets (K, web): presets can only be changed BEFORE a session's first message, then frozen (server rejection + disabled picker with localized tooltip). Why: the tool list is part of the provider-cached prefix; mid-session changes re-bill the whole cache. Start-time saved-preference pin and tree-nav same-selection re-pin unaffected; extension-internal tool changes not gated.
- Poisoned-transcript fix (L, core): root cause of "Tool memory_write not found" — a pre-R2-1 web wrapper recorded all 9 neko tools as removed in the transcript; pi's sticky restore replayed it forever. Fix: `declareToolChanges` scopes the baseline to currently-registered tools (never record removals of tools you never had), and a shared `ensureSystemToolsActive` before_agent_start hook re-activates all 9 neko system tools (poisoned sessions self-heal on their next turn). Sticky-restore semantics preserved for genuinely removed tools.
- Rebrand (M, web): user-visible "Pi Web" → "Neko-Pi" everywhere (brand button, hero, title, metadata, manifest + env override kept, login, i18n ×3, basic-auth realm — browsers re-prompt for the password once); `devIndicators: false` hides the Next.js dev badge in dev mode.

Verification: full apps/web suite 3236/3235/0 fail; core memory/agent suites green (77 + 80 + 107 + 135 batches); root `npm run check` exit 0; deployed to the live dev server via build + sync:pi (installed dist verified: `ensureSystemToolsActive`, new preamble, 9 injection tags); live browser verified (brand/hero/title, dev badge gone, poisoned session self-heals on next query). Test-residue re-sweep: Task K's predicate-verification session removed.

Do not commit unless the user asks.
