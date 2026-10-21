# Product

<!-- impeccable:product-schema 1 -->

## Platform

Terminal application: OpenTUI and Solid on Bun, with a Node HTTP/SSE bridge to pi.

## Users

The owner uses Neko for ongoing conversation and development in a local project.

## Product Purpose

Give Neko a coherent, usable home: conversation, identity, memory availability,
project context, and settings should belong to the same product.

## Capabilities and Constraints

- The pi backend loads private persona packs and provides tools and inference.
- The frontend must show actual state rather than inventing memory or personality guarantees.
- Conversation history and native backend session pointers persist across bridge restarts.
- Global identity and runtime memory live under ~/.neko_pi; /init configures the shared identity.
- Settings must take effect, persist, and respect explicit mouse and animation preferences.
- Support small terminals and keyboard-only operation.

## Brand Commitments

- Product name: neko-pi. Resident: Neko, or the installed persona's display name.
- Remove inherited product advertising, unrelated onboarding, and incorrect support links.
- Keep third-party licenses and internal protocol/package identifiers intact.
- Persona content and private artwork remain outside the public repository.

## Evidence on Hand

- User-provided screenshots of the home screen, settings, and inherited onboarding.
- `docs/superpowers/specs/2026-10-20-persona-platform-design.md`.
- Persona loading and system-prompt compilation in `packages/coding-agent/src/core/`.

## Product Principles

- Personality is grounded in the installed pack, not repeated decorative copy.
- Private content is disclosed on demand, never copied into public UI assets.
- A visible control must work; availability and successful execution are different states.

## Confirmed Surface Decision

The owner chose identity, memory status, and an optional local portrait in the sidebar;
preserve the main conversation layout. Narrow terminals retain status access through `/neko`.

The owner subsequently rejected the oversized wordmark and blurry block portrait. Keep
the wordmark small and muted, and leave the portrait area blank for now.

The owner clarified that lettering quality, rather than the theme, is the remaining problem.
Use compact lowercase lettering with consistent proportions and restrained depth; preserve
the current theme for the owner to change separately.

## Current Status Semantics

The bridge reports installed identity/voice metadata, the number of active runtime memory
records, the last memory injection timestamp and maintenance outcome. These receipts do not
guarantee model compliance or enforce persona behavior. The frontend leaves the portrait
area blank. Legacy .neko_mem and AGENTS.md sources remain untouched.
