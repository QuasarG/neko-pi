# Memory and Continuity Refactor Design

Date: 2026-10-25
Status: approved for implementation (user approved the direction and the metadata/budget/security recommendations)
Scope: `packages/coding-agent`

## Problem

The current system has three structural faults found in the two-day audit:

1. Long-term memory injects a whole scope snapshot whenever either visible scope version changes. One changed record re-sends every record in persona plus the current project, including intimate persona books in work sessions.
2. Continuity is one global persona row written on a fixed every-third-query cadence. Work summaries and personal summaries overwrite each other and follow every project; project continuity rows exist but stay empty.
3. Memory changes are not observable: `memory_write` replaces one record file in full, but the UI shows only a generic argument dump plus `personamerged (file) vN`. Conflict and rejection results are not marked `isError`, and injected memory shows only a version/count, not which document changed or why.

There is also no home for durable facts about an external topic (for example infrastructure for a website discussed from an unrelated cwd). The model is forced to misfile them into the current project or persona.

## Goals

1. Split long-term memory into three scopes:
   - `persona`: global Neko/user memory, available in every session.
   - `project`: reusable memory for the canonical working directory, available only to sessions in that project.
   - `scratch`: durable-but-unassigned facts ("待归档"), visible only to their originating session until explicitly promoted or recalled by topic.
2. Inject per record:
   - a new session gets one budgeted baseline of visible records;
   - afterwards only the full text of records whose content hash changed;
   - removed records produce a short withdrawal (tombstone), never a silent disappearance.
3. Split continuity:
   - project continuity holds the work stage and is visible only in the same project;
   - persona continuity holds only the personal interaction stage and is global;
   - no fixed every-third-query mandatory write. Updates are semantic, with a low-frequency tenth-query reminder and explicit user-memory hints.
4. Make writes observable and safe:
   - tool details include scope, absolute file path, old/new version, old body, and a line diff;
   - conflicts and rejections are real error results;
   - obvious secret material is refused with guidance to store a reference instead;
   - budgets use UTF-8 bytes and per-scope record caps.
5. Preserve existing data. Old sessions and records must keep loading; migration may add capabilities but never rewrite or move existing memory bodies.

## Non-goals

1. No semantic topic-to-project auto-classification. A scratch record does not guess a future project.
2. No task/thread lineage key for continuity in this pass. Same-cwd parallel tasks still share project continuity; this is a known limitation.
3. No new sidecar metadata format. Frontmatter plus the existing SQLite index remains the single production pipeline; a third source of truth is explicitly rejected.
4. No prompt-level listing of concrete topics or projects (no "AITIME", no "server IP" examples in model-facing rules).
5. No polling. Injection decisions happen on query start and after successful writes.

## Memory model

### Scopes and identity

```ts
export type MemoryScope =
  | { scope: "persona" }
  | { scope: "project"; projectId: string }
  | { scope: "scratch" };
```

- `scopeKey` returns `persona`, `project:<projectId>`, or `scratch`.
- Project identity remains the SHA-256 of the canonical cwd. Scratch has no project id.
- Scratch records persist in `memory/scratch/` using the same record file format and history directory as other scopes.

### Record metadata

The Markdown frontmatter remains the canonical record metadata. Scratch adds optional fields:

```yaml
origin_session: <native session id>
origin_cwd: /abs/cwd
target_project: <projectId or unset>
```

Every record already carries `id`, `type`, `title`, `version`, `updated`, and content hash in SQLite. No sidecar file is added.

### Caps and byte budgets

| Scope | Active records | Active storage | Injection delivery budget |
|---|---:|---:|---:|
| persona | 6 (existing) | 64 KiB (existing) | 64 KiB per query |
| project | 3 (changed from 8) | 32 KiB (existing) | 32 KiB per query |
| scratch | 3 | 16 KiB | 16 KiB per query |

- Delivery budgets equal the active storage ceilings. A smaller delivery bound is a second, hidden cap: real data proved it (six persona books totalling ~18 KiB against a 16 KiB delivery cap left one book permanently un-injected while its omission notice repeated every query). Steady-state delivery still carries only changed records; the full scope appears on baseline or a mass update.
- Existing project stores with four records are not trimmed. Caps only refuse new topics, as today.
- Oversized delivery is honest: list the omitted record titles and file paths; never truncate a delivered body silently.
- Record count and byte caps never block merging an existing topic.

### Secret material

New writes are refused when the body contains obvious secret material:

- a PEM private-key block;
- an assignment such as `password:`, `token:`, `secret=`, or `api_key=` with a concrete value.

The rejection note tells the model to store a reference (path, environment variable, or secret manager identifier) instead. IP addresses, ports, usernames, key file paths, and account ids remain allowed.

## Write pipeline

`MemoryChannel.write` stays the only production path and keeps its current conflict/journal semantics, with these additions:

1. `expectedVersion` is required when merging an existing record. The tool fills it from the record metadata when the model omits it, so the model no longer has to volunteer it. A stale explicit value still conflicts.
2. Successful results carry:
   - `scope`, `absoluteFile`, record id/title/type, old and new version;
   - the previous body when a record was merged, for UI diffing;
   - action and optional note.
3. Conflict and rejected results are returned by the tool with `isError: true`.
4. Scratch origin metadata is stored on creation and preserved on merges.
5. Promotion is an explicit operation (`memory_promote`):
   - input: scratch record id plus target scope (`persona` or current project);
   - behavior: write the record through the normal channel, then remove the scratch active record and register a scratch change so per-record injection can withdraw it;
   - target history and scratch tombstone are both preserved.

## Per-record delivery

### Receipt key

For each visible record:

```text
kind = "memory_record"
ref  = "<scopeKey>#<recordId>"
version = parseInt(sha256(serializedRecord).slice(0, 8), 16)
```

The fingerprint hashes the whole serialized record, so a version bump with identical content does not re-inject, while a title/body/frontmatter change does.

### Visibility

- Persona records: every session.
- Project records: sessions whose cwd resolves to the same project id.
- Scratch records: only the session named by `origin_session`. Other sessions can find them only through explicit `memory_recall` by topic.

### Query-time algorithm

Run at every `before_agent_start` for a user message:

1. Sync external persona/project file changes (existing behavior).
2. Compute visible active records.
3. For each record with no receipt, deliver with reason `baseline` (first record in a new session) or `new`.
4. For each record whose receipt fingerprint differs, deliver the full document with reason `updated`.
5. For each `memory_record` receipt whose record is no longer visible:
   - if the record no longer exists or was archived/promoted, deliver a tombstone with reason `removed`;
   - if a project record is invisible only because the session moved to another cwd, deliver nothing.
6. Apply scope delivery budgets in record update order and list omitted records.
7. Queue receipts only after the user message is persisted (existing pending-turn receipt mechanism).

A successful in-session write marks its own per-record receipt, preserving the existing self-delivery behavior. `/edit`, `/undo`, and compaction clear receipts as they do today, causing an honest baseline resend.

### Wire format

`<runtime_memory>` remains one user-tail block and starts with the same historical-data warning. Its body is human/model-readable Markdown sections:

```markdown
### Memory baseline: persona
- record: 工程经验（分域）
- type: procedure · version: 13 · bytes: 1557
- file: /home/zexin/.neko_pi/memory/persona/procedure-....md

<body>

### Memory update: project bed947e0
...

### Memory removed: persona
- record_id: rec_x
A previously delivered record no longer exists; discard its earlier content.
```

Continuity text remains separate labeled text in the same block, never mixed into record sections.

## Continuity model

### Scope selection

- `continuity_update` defaults to project scope.
- Explicit `scope: "persona"` remains available for the personal interaction stage.
- System prompt rules say:
  - project scope records work stage, blockers, and next steps only;
  - persona scope records personal/relationship stage only;
  - work content in persona and personal content in project are routing failures and must be corrected by rewriting the correct scope.

### Triggers

1. Semantic updates are always allowed and encouraged when the stage materially changes.
2. A tenth-query reminder is a non-owing hint. It appears on that query only and does not repeat on later queries when skipped.
3. An explicit memory hint is appended when the user's text contains an imperative memory cue (for example "remember this", "记住这个", "别忘了", "以后", "下次") but not a pure recall question ("你还记得吗"). The hint says to evaluate a durable write; it is not an order to write.
4. Memory system rules additionally instruct the model to evaluate maintenance at important milestone endings: confirmed decisions, reusable lessons, corrections, and stable access facts. The instruction stays abstract and contains no project-specific examples.

### Cadence entries

- The every-third-query `continuity.persona.saved` debt model is removed.
- The tenth-query reminder is derived from the existing shared query ledger without a new persisted debt entry.
- Memory's tenth-query floor remains unchanged: it is a floor, not a schedule.

## Tool interface

### `memory_write`

Parameters add:

```ts
scope: "persona" | "project" | "scratch" (optional; existing defaults stay for persona/project)
origin_cwd?: string (scratch only, filled by the harness)
```

The harness supplies `origin_session`. The result text stays compact for the model; rich data lives in `details` for the UI.

### `memory_promote`

New tool:

```ts
record_id: string
scope: "persona" | "project"
target_project_cwd?: string  // scope=project only: promote into another project's store
target_version?: number      // required when the target already holds a same-topic record
```

It moves a scratch record to the target scope, returns rich details, and is rendered by the same memory tool renderer. `scope: "project"` resolves the target as `target_project_cwd`, else the record's `origin_cwd`, else the current project — so an `origin_cwd`-tagged scratch fact promotes into its owning project from any session. When the target scope already holds a same-type+title record, the promote conflicts until `target_version` acknowledges that record's current version (the merge replaces the target body with the scratch draft, so overwriting content the caller never read must be explicit).

### `memory_recall`

Searches persona, current project, and all scratch records. Scratch results include their origin session/cwd and target status so the model can propose promotion instead of duplicating facts.

## Frontend

### Memory tool rows

A dedicated renderer for `memory_write`, `memory_promote`, and `continuity_update` shows:

- scope badge: `persona` / `project <name>` / `scratch` / `scratch → project`;
- record title and type;
- action with real status colors (`created`/`merged` positive, `conflict`/`rejected` error);
- `v4 → v5`;
- linked absolute file path (shortened with `~`);
- a bounded line diff (`-` old, `+` new) computed from the previous body in details;
- the note/reason on failure.

The rows continue to participate in the current two-level Thought/tool group.

### Injected context rows

`producerSummaries` parses the new delivery format. Collapsed rows show:

- `baseline` or `update`;
- per-scope counts and versions, e.g. `persona 2本 · project 1本`;
- `removed ×N` when withdrawals are present;
- `便签 project/persona ×N` separately;
- omitted count when budget drops documents.

Expanded view renders the delivered Markdown with file paths already present.

## Compatibility and migration

1. SQLite schema moves to version 3 by rebuilding only tables whose `scope` CHECK constraints exclude scratch (`memory_records`, `write_journal`). All existing rows are copied unchanged.
2. Existing Markdown records are not rewritten. Missing scratch frontmatter fields simply mean "not scratch".
3. Old `memory_catalog` receipts are ignored by the new per-record path. Each existing session receives one baseline on its next user query, then returns to per-record updates.
4. Existing continuity persona content stays where it is. New writes follow the new routing; no content is moved or deleted.
5. Old tool calls without `scope` still execute. `memory_write` keeps today's persona/project defaults; only `continuity_update` changes its default to project.
6. Existing session JSONL files render unchanged except for richer tool details for future calls.

## Testing strategy

1. Data layer: schema v3 migration preserves rows; scratch rows pass checks; budgets and secret rejection are unit-tested.
2. Store/channel: scratch round-trip, origin metadata, promotion, mandatory merge version, previous-body result.
3. Delivery: baseline, single-record update, unchanged-record silence, deletion tombstone, project invisibility on cwd change, scratch origin visibility, budget omission, self-delivery, truncation resend.
4. Continuity: project/persona split, routing rules, tenth-query non-owing reminder, explicit memory hint, recall-question non-trigger.
5. Tools: conflict/rejection `isError`, details shape, promotion.
6. Frontend: renderer scope/path/version/diff, collapsed injection summaries.
7. Compatibility: old DB fixture migrates; old session with `memory_catalog` receipt gets exactly one baseline; existing records and continuity load.
