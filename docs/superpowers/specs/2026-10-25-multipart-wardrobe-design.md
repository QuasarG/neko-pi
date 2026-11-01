# Multi-Part Wardrobe and Selection Integrity Design

Date: 2026-10-25
Status: approved for implementation (user requested the upgrade and data compatibility)
Scope: `packages/coding-agent`

## Problem

Two separate faults emerged from the latest sessions:

1. The wardrobe tool was always declared and functional, but the model often treated the injected outfit as known state and narrated clothing changes without calling `wardrobe wear`. One explicit command worked immediately, so this is a prompting/affordance problem, not tool loss.
2. The shared outfit flipped from `seal-night-001` to `camping-bandage-001` without a tool call. The runtime activity ledger proves the cause: test rows `seq 347–350` (`hello`, `what about tomorrow?`, timestamps pinned to the previous midnight) leaked into the real `~/.neko_pi/runtime/state.sqlite` because `runtime-context.test.ts` did not stub `NEKO_PI_HOME`. The test also stamped `wardrobe_state.last_user_at` with its fake clock; the next real query at 21:46 therefore looked idle for over six hours and the existing random idle selection changed the outfit. The six-hour mechanism works; its clock was polluted.

The wardrobe model itself is also too flat: an outfit is one `{id,name,description}` blob. The user wants outfits composed from multiple body-part items.

## Goals

1. Keep the existing shared selection model and six-hour idle behavior, but make test leakage into the real runtime state impossible from the suite harness.
2. Upgrade wardrobe data to a part catalog plus outfits that reference parts by slot, while loading every existing wardrobe.json unchanged.
3. Make part combinations first-class outfits with stable deterministic ids, so existing receipts, database selection, lock behavior, and snapshots continue to operate on outfit ids.
4. Make outfit delivery change when the content changes, not only when the id changes.
5. Make the model's obligation explicit: narration does not change clothing; only `wardrobe wear` does.

## Non-goals

1. No per-slot runtime database state. A worn combination remains an outfit id; this preserves receipts, frozen snapshots, `/context`, and activity behavior without a schema migration.
2. No automatic random mixing of individual parts. Idle selection chooses among outfits (including saved combinations), avoiding surprising auto-generated clothing.
3. No deletion or rewrite of the user's real wardrobe.json or runtime database by code. Pollution cleanup is a separately confirmed operation.
4. No fixed slot enum. Slots are normalized strings supplied by the user/model (for example feet or torso), validated for length and shape.

## Data model

```ts
export interface WardrobePart {
	id: string;
	slot: string;
	name: string;
	description: string;
}

export interface Outfit {
	id: string;
	name: string;
	description: string;
	parts?: Record<string, string>; // slot -> part id
	generated?: boolean;
}

export interface Wardrobe {
	outfits: Outfit[];
	parts?: WardrobePart[];
	locked?: string;
}
```

Compatibility rules:

- An old file with only `outfits[{id,name,description}]` loads identically.
- A new outfit may omit `description` only when it has a non-empty `parts` mapping. The loader synthesizes a description from the referenced parts.
- Part ids and outfit ids share uniqueness namespaces only within their own collections; an outfit may not duplicate another outfit id, and a part may not duplicate another part id.
- `parts` mappings must reference existing part ids. A slot key must be normalized (`slug`, at most 32 characters); at most one part is selected per slot in an outfit.
- `generated: true` marks an outfit created by `wear parts`; it remains editable and removable like any other outfit.

### File format

New files may look like:

```json
{
	"parts": [
		{ "id": "white-lace-sock", "slot": "feet", "name": "蕾丝白袜", "description": "..." },
		{ "id": "none-torso", "slot": "torso", "name": "无上装", "description": "..." }
	],
	"outfits": [
		{
			"id": "combo-a1b2c3",
			"name": "白袜组合",
			"parts": { "feet": "white-lace-sock", "torso": "none-torso" },
			"generated": true
		}
	]
}
```

The synthesized description is stable and human-readable, one line per selected slot:

```text
feet — 蕾丝白袜：...
torso — 无上装：...
```

## Tool interface

The existing `wardrobe` tool keeps its name and actions. Parameters extend to:

```ts
action: "list" | "add" | "add_part" | "remove" | "remove_part" | "lock" | "wear"
id?: string
name?: string
description?: string
slot?: string                 // add_part
parts?: Record<string, string> // add/wear
```

Behavior:

- `list` reports:
  - current outfit and lock;
  - parts grouped by slot;
  - outfits with their slot mapping and generated marker.
- `add_part` requires `id`, `slot`, `name`, and `description`; slot is normalized.
- `remove_part` refuses while any outfit references the part.
- `add` creates a preset outfit. It accepts either a full `description` (legacy shape) or a `parts` mapping with an optional description override.
- `wear` accepts exactly one of:
  - `id`: wear an existing outfit;
  - `parts`: resolve the mapping, derive the deterministic outfit id `combo-<10 hex>`, create or update that generated outfit, then wear it.
- `remove` and `lock` operate on outfits exactly as today, including generated combinations.
- Errors remain ordinary text results today; no behavior changes outside wardrobe.

Deterministic combination id is the first ten hex characters of SHA-256 over canonical `slot:part` pairs sorted by slot. Re-wearing the same mapping reuses the outfit and refreshes its name/description only when its source parts changed.

## Selection and delivery

1. Busy window (`now - last_user_at < 6h`): keep the exact current outfit id, including combinations.
2. Idle window: choose uniformly among outfits other than the current one, exactly as today. Saved combinations participate; individual parts do not.
3. Lock still wins over idle selection.
4. Activity `outfit_changed` payload becomes `<id>: <name>` so audits identify both fields.
5. Outfit delivery fingerprint hashes canonical JSON of `{id,name,description,parts}` rather than only id. Description or part edits therefore re-deliver to sessions that already saw the old id.
6. `<runtime_activity>` outfit preamble explicitly says narration does not change clothing and only `wardrobe wear` changes state.

## Prompting and UI affordance

- Tool description and prompt snippet state the contract: inspect with `list`, change only with `wear`, never simulate a change in prose.
- The injected outfit remains a JSON object with id, name, description, and parts mapping when present.
- `producerSummaries` parses the JSON outfit field and shows `穿着 <name>` in the collapsed injection row, fixing the currently dead `^outfit:` regex.

## Test isolation and real-data safety

1. `createHarness()` defaults `NEKO_PI_HOME` to its temporary directory when no override exists, and removes that default on cleanup. Tests that intentionally stub another home still work.
2. The midnight runtime-context test no longer writes to `~/.neko_pi`.
3. No production migration deletes the four leaked activity rows or changes the user's real wardrobe. They are inert after the timestamp moved on; cleanup can be offered separately with a backup.

## Testing strategy

1. Harness isolation: creating a harness without an env override never touches the real home.
2. Loader compatibility: legacy file unchanged; parts validation; synthesized description; invalid references rejected.
3. Tool: add/remove parts, reference guard, preset add, deterministic `wear parts`, re-use, lock/remove behavior.
4. Selection: busy keeps combinations; idle changes outfit; lock wins.
5. Delivery: same id but changed description/parts re-injects; unchanged outfit does not.
6. Prompt/audit: collapsed injection shows the outfit; tool guidance mentions `wear`.
