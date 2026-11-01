# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-10-31
- Primary product surfaces: `apps/web` (Pi Web — chat UI for the pi coding agent; desktop-first three-column shell, mobile down to 480px)
- Evidence reviewed: `zai-org/ZCode` at `a60ba6a`, specifically `DESIGN.md`, `packages/ui/src/styles.css`, `components/ui/button.tsx`, `components/ui/input.tsx`, `components/ui/dropdown-menu.tsx`, `prompt-editor/ChatPromptEditor.tsx`, `ToolCallBlocks/ToolLayout.tsx` and `ToolSummaryRow.tsx`; the current Pi Web browser page and existing theme/component sources. User directive 2026-10-31: retain Pi Web layout; match ZCode component styling and design language; remove the outlined, cell-divided Pi Web treatment. Sharpened the same evening: the conversation area (chat stream + composer + status card) is a VERBATIM port of ZCode — component anatomy, icons, motion and look copied from the ZCode source (exact-value catalogs in `.superpowers/sdd/zcode-ui-alignment/`); only control positions may differ. The `/` slash palette keeps Pi Web's big-card design (user exemption). Brand = Zai ink (an official ZCode theme; no sky-blue single-point saturation).

## Brand
- Personality: ZCode's calm, dense, operational frontend, expressed within Pi Web's layout. ZCode is the component-style authority, rather than an ingredient to blend with a second visual system.
- Trust signals: Consistent neutrals, restrained accents, no marketing-style pop, WCAG-conscious text contrast.
- Avoid (user directive, binding): 廉价的高对比度撞色 — cheap high-contrast color clashes, saturated accent-vs-background collisions, decoration via feedback colors. When in doubt between two values, pick the quieter one.

## Product goals
- Goals: Feature-parity web client of the neko-pi TUI that feels like a native-quality desktop app; fast, keyboard-friendly, dense but breathable.
- Non-goals: Moving Pi Web's navigation, conversation, composer or file viewer; inventing a hybrid visual style; porting ZCode's application/runtime or adding dependencies just to reproduce its presentation.
- Success signals: Chat, navigation, composer and file viewer read as one product in the same screenshot; required checks and targeted tests pass; no regression in keyboard/a11y flows. Test counts are not a fixed design contract.

## Personas and jobs
- Primary personas: The owner (developer, daily driver, dark-theme default); collaborators using light/mobile occasionally.
- User jobs: converse with the agent, read long transcripts with tool output, manage sessions/projects, review files and terminals, grant consent (trust/share/bug dialogs).
- Key contexts of use: Desktop multi-column with resizable panels; laptop ~1280px; mobile ≤640px overlay mode.

## Information architecture
- Primary navigation: left rail (session tree + files tabs); top bar (panels, stats, debug); right panel (file tabs, terminals, subagent viewer).
- Core routes/screens: chat shell (single route + `?cwd=`), Settings dialog sections, consent dialogs (trust/share/bug), command help.
- Content hierarchy: message stream center; transient status as notices/overlays; chrome de-emphasized.

## Design principles
- 1. Quiet color, layered depth: hierarchy from background micro-shifts and alpha overlays, not hue or saturation jumps.
- 2. One motion language: all motion references the token ladder (fast/low-drama); nothing animates longer than 320ms except ambient loops.
- 3. One workbench: permanent panes meet at structural dividers without outer card frames or gutters. The navigation rail is recessed using a theme-derived surface. Elevation is reserved for transient menus and dialogs; the composer has a quiet edge and a focus cue.
- 4. Reduce before you animate: `prefers-reduced-motion` and hidden-document throttling are acceptance gates, not afterthoughts.
- 5. User-perspective coherence (user directive 2026-10-31): every element visually BELONGS to its conversational side — a user message's attached content (injected context, attachments, quotes) groups with the user's bubble, tool/thinking activity groups with the assistant's flow; nothing meaningful "just pops" — entrances follow the motion ladder; styling stays inside the token system. When auditing, ask: does a first-time user immediately see what belongs to whom?
- Tradeoffs: Preserve behavior and semantic DOM contracts, while allowing explicit styling hooks. Visual coherence is assessed across the whole workbench; existing tests and browser checks verify behavior rather than assuming selector preservation guarantees it.

## Visual language
- Color: Default light/dark materials follow ZCode's Zai Light / Zai Dark roles: neutral primary actions, separate input/card/popover surfaces, restrained hover and selection fills. Values live in `app/globals.css`, mapped through the existing variables plus `--workspace-rail`, `--surface`, `--card`, `--popover`, `--input` and `--secondary`. Text metadata keeps the existing accessible opaque ramp; file-type icons retain their descriptor colors. Optional palettes retain their values through the same component roles.
- Typography: one knob-anchored ladder — `--chat-content-font-size` (default 16px) is the base; conversation text derives from it or calc() offsets (meta −2, caption −3, headings +4/+2/base). Tool rows, markdown body and stream text share the knob (pinned by `app/font-ladder.test.mjs`); paths/commands/ids mono (Noto Sans Mono stack); UI font = platform sans.
- Spacing/layout rhythm: 4px base grid; no desktop pane gaps or outer insets. Permanent pane headers share `--workspace-header-height: 44px`; desktop toolbar controls and file tabs are 32px high with 2px gaps. Chat column retains the user's width preference and adaptive maximum.
- Shape/radius/elevation: keep Pi Web's pane arrangement, using flat structural separators. ZCode radius ladder: 4/6/8/12/16px. The main input uses its explicit 16px exception, a 0.5px edge, input material, 12px padding and ZCode's composer shadow. Menus use 8px shells with 6px option fills; dialogs use 16px shells. Primary actions use neutral fill, secondary actions use secondary material, ghost actions remain clear until hover. Tool summaries, thinking and injected-context chips do not receive outlined boxes merely to distinguish them.
- Motion: token ladder 120/160/200/320ms, ease cubic-bezier(0.22,0.61,0.36,1), plus ZCode's conversation literals: the 900ms `cubic-bezier(0.16,1,0.3,1)` message-level stream entrance (`.transcript-entry-in`, gated by the first-paint/prepend exemptions — per-paragraph markdown fade stays OFF), the 4s `gradient-flow` text sweep on running tool kind labels, the summary roll (±0.8em, 300ms, 500ms hold, queue ≤2), and 300ms ease-in-out disclosure folds with delayed unmount. Panel and overlay behavior retains the existing responsive and reduced-motion gates. Do not add animation solely to decorate a high-frequency interaction.
- Imagery/iconography: inline SVG icon set, opacity-degraded by hierarchy (secondary 60%, tertiary 40%/30% dark).

## Components
- Existing components to reuse: everything — the redesign restyles through existing selectors (SettingsUi `config-*`, `project-trust-*` chassis, `markdown-*`, `session-tree-*`, `settings-dialog-*`, `panel-resize-handle`, `chat-input-*`).
- New/changed components: workspace toolbar hooks in AppShell, composer surface hook in ChatInput and thinking-icon hook; shared material/radius roles; sidebar header, file tabs, dropdowns, model and reasoning options, Markdown containers, settings controls and consent dialogs use the same component vocabulary. No components renamed.
- Variants and states: existing `is-*` state modifiers unchanged.
- Token/component ownership: tokens in `app/globals.css` (:root + [data-theme]); per-sheet selectors unchanged.

## Accessibility
- Target standard: WCAG AA for body text in all themes (AAA preserved in contrast themes); keyboard paths are first-class (resizers, menus, dialogs focus-managed via stacked-dialog).
- Keyboard/focus behavior: unified focus ring token; no keyboard flow changes in this redesign.
- Contrast/readability: adjust text values within a theme when a Zai-mapped background reduces contrast; never brighten backgrounds/accents into clashes.
- Screen-reader semantics: roles/aria preserved verbatim (test-pinned).
- Reduced motion: every new animation ships with a `prefers-reduced-motion: reduce` cutoff; hidden-document animation throttling.

## Responsive behavior
- Supported breakpoints: ≥960px split panels; 641–959px right-panel overlay + backdrop; ≤640px sidebar overlay; ≤480px narrow-mobile sheet. No desktop outer frames.
- Layout adaptations: panel width CSS vars + resize handles (2px sky indicator on hover, catalog #9); chat column adaptive width.
- Touch/hover differences: hover-revealed actions only where they already exist.

## Interaction states
- Loading: pixel-dot + shimmer vocabulary (Wave 3), not spinners-first; running heartbeat lamp.
- Empty: centered welcome card (2xl radius) with waterfall suggestion prompts.
- Error/success: notices shelf + inline banners, semantic colors only.
- Disabled: opacity degradation per icon/text hierarchy tier.

## Content voice
- Tone: technical, terse; all UI strings through i18n (en source of truth; zh-CN/zh-TW parity enforced by test).
- Terminology: pi coding-agent domain terms.
- Microcopy rules: no emoji in UI strings; consent dialogs state exactly what leaves the machine.

## Implementation constraints
- Framework/styling system: Next.js 16 App Router; CSS custom properties + four stylesheets + opportunistic Tailwind v4 (existing usage only; NO paradigm migration, NO new deps).
- Design-token constraints: keep every existing CSS variable name (documented contract); new tokens additive.
- Performance: motion must be transform/opacity-first; avoid layout-thrashing transitions on scroll paths; no animation libraries.
- Compatibility constraints: preserve roles, accessible names, IDs, event handlers, virtualization geometry, z-index ladder and notice-shelf keyframe values. Presentation assertions may be updated to reflect the requested component style; behavior must remain covered.
- Test/screenshot expectations: run the root check, web typecheck/lint and focused tests for changed components. Inspect the live page at desktop and mobile widths, including keyboard focus and reduced motion. Never run a build or full test suite without the user's request.

## Open questions
- [ ] Existing detached popup and expanded-tool inline styles should continue migrating to semantic roles when those components next change; do not add fresh raw colors or new outline-only variants.
- [ ] Command palette behavior remains Pi Web's; changes to its information architecture are a separate feature decision.
- [ ] Whether the 12 non-default themes should eventually be re-derived from the new token scales (values unchanged this round).
