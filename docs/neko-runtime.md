# Global runtime state

The default root is `~/.neko_pi`, overridden explicitly with `NEKO_PI_HOME`.
Models, credentials, settings, persona, memory, sessions and terminal state use this root.
Persona content belongs to the installed pack, not the public product source.

On CLI startup, legacy `~/.pi/agent` contents are copied into the new root,
with byte verification and existing destination files taking precedence. Other legacy
contents retain their relative paths. The original directory is retained as
`migrations/legacy-pi`; conflicts are listed in `migrations/pi.json`. Sources containing
`AGENTS.md` or symbolic links are left in place to protect their original paths.
The migration never modifies `.neko_mem` or `AGENTS.md`. neko-pi does not load workspace
instruction files into the persona path; persona, memory, and continuity are read from `~/.neko_pi`.
Restart older running processes after migrating: they retain their original paths until restarted.

## Initialization

Use `/init` in the terminal frontend. Missing identity is indicated without opening a
mandatory wizard. The five steps configure name, identity, expression preferences,
IANA timezone and final review. Existing identity is prefilled; completed steps are
saved in a private resumable draft. Escape exits. Model connections remain in
`models.json`, credentials in `auth.json`, and `/models` selects configured models.
Saving identity waits for running conversations to finish. Every subsequent run
refreshes the global persona, including already-open sessions. A local timestamp is added
once to each newly created user message and is retained with that message; existing history
is not rewritten. The TUI displays the original submitted text without the timestamp.

## Memory

Memory is derived context, not an instruction source or an event transcript. Records
carry one of six types (`promise`, `episode`, `anchor`, `whisper`, `profile`,
`procedure`) and one of two scopes: `persona` (shared across projects) or `project`
(bound to the SHA-256 of the session's canonical working directory). Same-basename
directories stay distinct projects; runtime state lives in `runtime/state.sqlite`
(Node's built-in SQLite) while record bodies stay plain markdown under
`memory/persona/` and `memory/projects/<name>--<hash>/records/`.

The model navigates memory through a small catalog injected when a visible scope's
version changes, then reads record files with the normal read tool. Per-turn keyword
recall injection is removed by design. Updates replace summaries and preserve full
previous versions in `history/`; hand edits and deletions are detected by content hash
and registered as external changes. Writes go through one channel with stable record
IDs, optimistic versions (`expected_version` conflicts instead of overwriting), a
file+database double-write journal, and idempotent crash recovery. Legacy flat
`memory/*.md` layouts migrate once into the scoped layout with a verified backup;
work-context records without a recoverable project wait in `memory/pending-review/`
instead of being guessed into a scope.

Summary reflection is opt-in (`runtime.json` `{"memoryReflection": true}`); it does not
run by default. When enabled it accepts bounded
recent text only, and failures preserve previous memory. The model can call
`memory_write` (with `scope` and `expected_version`), `memory_recall`, and
`continuity_update` for persona or project scope. Individual writes are limited to
16,000 UTF-8 bytes; automatic extraction accepts up to three records of 2,000 bytes
each per completed turn.

Context budgets are conservative UTF-8 byte limits, not exact provider token counts:

| Layer | Limit |
| --- | ---: |
| Recent shared interaction state | 400 |
| Standing facts and commitments | 800 |
| Topic recall per run, including tool recall | 1,800 |
| Total memory content | 3,000 |

Persona and ordinary session transcript are separate from this memory budget. A later
turn can retain previous tool output in its native transcript; normal transcript
compaction remains responsible for that history. Disk archives are retained rather
than deleted and can grow over time.

Recent interaction state expires after six hours. Continuity keeps two scoped rows:
persona (global interaction state) and per-project work stage. A new user turn claims
a revision; a stale session's commit fails instead of overwriting a newer turn.
Workspace-specific technical context remains in its original session. Cross-session
continuity uses only the bounded shared summary; it does not promise exact
reenactment or automatic persona enforcement.

Persona continuity has a mandatory checkpoint on every third user query in each
session (queries 3, 6, 9, and so on). A successful `continuity_update` in persona
scope must occur during that checkpoint before the run can settle. Project writes,
empty summaries, oversized summaries, and stale-version failures do not satisfy it.
If the model attempts to finish without saving, the native `agent_before_settle`
boundary adds a continuation requesting the tool call. A provider error or user
interruption ends execution without clearing the pending checkpoint; the next run
must satisfy it. A model that repeatedly omits the required write keeps continuing
until it saves, fails, or is interrupted.

Counts and successful checkpoints are derived from entries on the native active
branch, survive restart and compaction, and follow message truncation. Extension-authored prompts and checkpoint
continuations do not count as user queries. Forked queries and checkpoints marked
with another session's ID do not advance the new fork's cadence. Legacy unmarked
user entries are counted as existing history. The shared persona summary remains
global, but another session's write cannot satisfy this session's checkpoint. On
a version conflict, the tool returns the current summary and version; the model
must merge it and retry using `expected_version` rather than silently overwriting
the newer summary. This checkpoint is independent of opt-in summary reflection.

Each accepted message records its receipt time, time zone, visible scope versions,
activity cutoff, and activity/outfit snapshot; duplicate message IDs are idempotent
no-ops. Activities are pruned after 21 days; already-delivered snapshots stay as
they were.

## Session recovery

The frontend session catalog/history and native backend session references persist
under `sessions/`. Reopening a session resumes its native transcript. Incomplete runs
appear interrupted after restart. Pending queued input is retained but is not executed
automatically at startup. Starting another turn drains that session's queued input.

The interface shows record counts, injection timestamps and maintenance outcomes.
These indicate runtime activity, not proof that the model followed every memory.
