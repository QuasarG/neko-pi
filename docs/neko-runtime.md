# Global runtime state

The default root is `~/.neko_pi`, overridden explicitly with `NEKO_PI_HOME`.
Models, credentials, settings, persona, memory, sessions and terminal state use this root.
Persona content belongs to the installed pack, not the public product source.

On CLI startup, legacy `~/.pi/agent` contents are copied into the new root,
with byte verification and existing destination files taking precedence. Other legacy
contents retain their relative paths. The original directory is retained as
`migrations/legacy-pi`; conflicts are listed in `migrations/pi.json`. Sources containing
`AGENTS.md` or symbolic links are left in place to protect their original paths.
The migration never modifies `.neko_mem` or `AGENTS.md`. The neko-pi bridge does not load
workspace instruction files; persona, memory, and continuity are read from `~/.neko_pi`.
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

Memory is derived context, not an instruction source or an event transcript. Confirmed
facts, preferences, commitments and reusable lessons are consolidated by stable title
and type. Updates replace summaries and preserve full previous versions in `history/`.
Old episodes and records beyond the active limit of 200 are archived losslessly.
Archive records remain searchable. Individual writes are limited to 16,000 UTF-8 bytes;
automatic extraction accepts up to three records of 2,000 bytes each per completed turn.

Each normal completed response triggers a separate summary request through the current
configured model. It receives bounded recent user/assistant text and known summaries,
not tool results or hidden reasoning. This adds a model request and can delay idle by
up to 12 seconds. Invalid or failed summaries preserve previous memory; `/neko` reports
maintenance failure. The summary does not enter the visible conversation transcript.
The model can also call `memory_write`, `memory_recall` and `continuity_update`.

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

Recent interaction state expires after six hours. A new user turn claims a monotonic
revision under a process lock; stale background summaries cannot overwrite a newer
turn's shared state or extracted records. Workspace-specific technical context remains
in its original session. Cross-session continuity uses only the bounded shared summary;
it does not promise exact reenactment or automatic persona enforcement.

## Session recovery

The frontend session catalog/history and native backend session references persist
under `sessions/`. Reopening a session resumes its native transcript. Incomplete runs
appear interrupted after restart. Pending queued input is retained but is not executed
automatically at startup. Starting another turn drains that session's queued input.

The interface shows record counts, injection timestamps and maintenance outcomes.
These indicate runtime activity, not proof that the model followed every memory.
