# Activity Digest and Home-Project Memory Cleanup Design

Date: 2026-10-26
Status: approved for implementation
Scope: `packages/coding-agent` runtime context plus one authorized real-data cleanup.

## Problem

`<runtime_activity>` currently injects a raw event list. A new session in a long-running project receives the newest events until an 8 KB payload budget is reached (65 events / about 10 KB JSON text in the observed case). Most entries are repetitive `continuity_updated` summaries and low-value `hello` queries; current memory/continuity state is already delivered elsewhere.

A legacy home-project copy of `近期余韵（2026-10 中旬）` was also created by an older agent after a persona conflict. It is a superset of the persona copy and must be merged back into persona, then withdrawn from the home project.

## Approved behavior

### Real-data cleanup

1. Back up the runtime database and both record files.
2. Write the home-project body (the superset, including the 10-25 night lesson) to the persona record as v4.
3. Merge tags and keep the higher salience.
4. Archive the home-project file under that store's `history/`.
5. Remove the home-project active row/file through external-delete synchronization so a tombstone remains.
6. Do not pre-mark delivery receipts: future sessions should receive the persona update and the project withdrawal normally.

### Activity storage previews

Future activity rows store bounded previews, not full text:

- `user_query`: at most 240 UTF-8 bytes;
- `continuity_updated`: at most 180 UTF-8 bytes;
- other event kinds: at most 240 UTF-8 bytes.

Truncation is byte-safe and appends `…` when it cuts. Existing rows remain unchanged.

### Session digest injection

New `ActivityContext` values carry:

```ts
interface ActivitySessionSummary {
	session: string;
	firstSeen: number;
	lastSeen: number;
	queries: number;
	recentQueries: string[];
	memoryUpdates: string[];
	continuityUpdates: number;
	outfitChanges: number;
}

interface ActivityContext {
	since?: number;
	through: number;
	sessions: ActivitySessionSummary[];
	omitted: number;
	historyExpired: boolean;
	outfit?: Outfit;
	/** Legacy snapshots only; newly prepared contexts omit raw events. */
	events?: ActivityEvent[];
}
```

Summaries:

- group selected events by session;
- keep at most two recent query previews;
- keep at most five unique memory-update labels;
- count continuity and outfit changes without repeating their bodies;
- order sessions by most recent activity.

The injected JSON uses `sessions`, not `events`, and explains:

- each entry summarizes activity from one session;
- `queries` counts user queries;
- `recentQueries` are bounded previews;
- `memoryUpdates` names changed records;
- `continuityUpdates`/`outfitChanges` are counts;
- `omitted` counts events excluded from the raw-event selection window.

The existing cross-session warning and wardrobe narration rule remain.

## Compatibility

1. Old frozen snapshots containing only `events` must still load.
2. On read, the runtime context normalizes a legacy snapshot by deriving `sessions` from its raw events in memory; it never rewrites the old snapshot.
3. New snapshots use the smaller digest shape.
4. Existing sessions continue from their activity receipts; they receive digests of future unseen events.
5. Raw activity rows stay in SQLite for audit; only future payloads are shortened.

## Edit resend (2026-11-01)

Editing a sent message and resending must keep the context that message already
carried. The web edit path is `navigate_tree` (leaf back to the edited
message's parent) followed by a normal `prompt`, so `runtime-context` recomputes
from the activity cursor and — with no unseen activity — attaches only
`<message_time>`.

Fix: the `prompt` command carries `reuseInjectedContext` (the raw delivered text
of the message it replaces, sent only when editing). `runtime-context` parses
that text, keeps `prepare()` for its bookkeeping (user-query row and activity
cursor), discards the recomputed digest, and re-attaches every parsed block
except `message_time` verbatim, in order. The new `<message_time>` is stamped
from the resend's own receipt time.

Consequences:

1. An edited resend is the old message's blocks with a new timestamp.
2. The activity cursor moves to the resend's position, so turns removed by the
   edit are never replayed later.
3. A prompt without `reuseInjectedContext` behaves exactly as before (digest
   only when something changed).
