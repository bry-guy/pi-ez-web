# Persistent subagent activity UI

Status: implemented (phases 1–3)

## Scope

Implement the first three parts of the subagent visibility work:

1. expose safe live subagent telemetry to the web runtime;
2. make the supervisor own a reconstructable subagent activity snapshot and
   stream ordered updates;
3. render grouped, persistent activity cards in the chat UI.

This phase deliberately does **not** implement child-transcript viewing,
stop/steer controls, or arbitrary extension widgets.

## Outcome

When Pi delegates independent work, the user can see parallelization before
any agent finishes:

```text
Parallel work · 2 running · 1 queued · 1 completed

◐ Search API usages       running · inspecting routes · 3 tools · 12s
◐ Review test coverage    running · reading tests · 1 tool · 8s
✓ Inspect package setup   completed · Found 4 relevant files
```

The activity remains attached to the parent session's transcript after a
refresh, and SSE reconnects do not lose or duplicate agent state. A user sees
stable task descriptions and coarse progress, not a stream of raw child-model
messages or tool arguments.

## Current gap

The existing implementation is completion-oriented:

- `server/activity.js` maps `subagents:record` and
  `subagent-notification` entries to generic activity records.
- `RealSupervisor._onEvent()` receives normal Pi session events and forwards
  persisted activity entries, but does not consume the subagent extension's
  event bus.
- The installed `pi-subagents` package already emits `subagents:created`,
  `subagents:started`, `subagents:completed`, and `subagents:failed`; it also
  has internal tool/activity callbacks. Those signals currently stop inside
  the extension.
- `public/js/thread.js` renders each live agent as an independent generic
  panel and moves completed agents into ordinary inline activity records. It
  has no group, parent-turn, revision, or progress model.
- Existing tests prove safe record normalization and the mock activity path;
  they do not prove that a real background agent becomes visible at spawn.

The web supervisor, not a transcript renderer, must become the source of truth
for live state. Pi transcript entries remain the durable recovery mechanism.

Implementation note: the application now bridges the lifecycle events exposed by
current `pi-subagents` releases and also consumes an optional
`subagents:progress` event. Tool-level live activity labels and counts become
richer when the installed package emits that optional event; the web layer does
not vendor or monkey-patch the external package.

## Data contract

Use a safe `SubagentActivityRecord` carried by the existing `activity` SSE
channel and transcript record list. Retaining `role: "activity"` and
`kind: "agent"` keeps the generic activity boundary and allows older clients
to ignore the new fields.

```ts
type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type SubagentActivityRecord = {
  id: string;                 // activity:agent:<runId>
  role: "activity";
  kind: "agent";
  key: string;                // agent:<runId>, stable replacement key
  runId: string;
  groupId?: string;
  parentMessageId: string;
  revision: number;
  status: SubagentStatus;
  title: string;              // bounded extension description
  activity?: string;          // bounded, stable phase label
  toolCount: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  summary: string;            // terminal summary only, when available
  error?: string;
  source: "pi-subagents";
};
```

Rules:

- `runId` is the extension agent ID; it is opaque and never interpreted by
  the browser.
- `groupId` is optional. Agents in the same parallel batch share it. Until a
  batch is finalized, the parent message is a safe temporary grouping key.
- `parentMessageId` associates the group with the assistant turn that spawned
  it. Do not expose session paths, prompts, child context, or credentials.
- `revision` increases for every accepted update. The browser applies only a
  newer revision for the same `runId`.
- `createdAt`, `startedAt`, and `endedAt` are ISO timestamps. The browser
  computes elapsed time from them; the server does not send a ticking timer.
- `toolCount` is a count, not a tool inventory. Live token usage is omitted
  from the first version; precise accounting can be added later if its
  privacy and cost semantics are clear.
- `activity`, `summary`, and `error` are allowlisted, bounded, stripped of
  control characters, and passed through the existing redaction helper.
- Map extension terminal states (`steered`, `aborted`, and `stopped`) to
  `completed`, `failed`, or `cancelled` with an explicit safe summary. A
  stopped or aborted run must never look like a successful completion.

The same run ID must replace the running record with its terminal record. A
final `subagents:record` emitted by the extension must merge into this model,
not create a duplicate card.

# Changeset 1 — live telemetry bridge

## 1.1 Define the narrow extension event surface

Use the existing `pi.events` lifecycle signals as the base:

- `subagents:created`: emit immediately after the background spawn has been
  accepted, including whether it is queued or running.
- `subagents:started`: emit when a queued agent actually begins execution.
- `subagents:progress`: add a coarse progress signal from the existing
  `onToolActivity`, turn, and usage callbacks. It should contain only the
  agent ID, a stable activity label, tool count, and optional turn count.
- `subagents:compacted`: retain as an optional activity/status update, not as
  child transcript content.
- `subagents:completed` and `subagents:failed`: include terminal status,
  bounded result/error preview, duration, and counts.
- `subagents:grouped` (or equivalent): notify the bridge when the debounced
  parallel batch receives its final `groupId`, so cards can be regrouped
  without changing their run IDs.

The `pi-subagents` package should be updated or given a small companion hook
so these events expose the fields above. The web application must not reach
into the package's private `AgentManager` or scrape its TUI widget. If the
package cannot provide the progress event without a release, pin the
compatible package revision in the deployment and document that dependency.

Progress must be coalesced (for example, at most once per 250 ms per agent,
with a harder per-agent rate limit) and use labels such as `starting`,
`reading files`, `running tests`, or `thinking`. Never emit raw tool
arguments, prompt text, arbitrary model deltas, or child session paths.

## 1.2 Add a web-only bridge extension

Add a small headless-safe extension under the application source, for example
`server/extensions/subagent-telemetry.js`. Load it automatically alongside
web sessions from `PiConfiguration`; it must be a no-op when the subagent
signals are absent.

The bridge should:

1. subscribe to the allowlisted `subagents:*` channels;
2. capture the current parent session/turn context at `session_start` and
   associate each event with the current parent message;
3. normalize every event to the safe record shape;
4. append a `pi-web:subagent` custom entry for lifecycle and coalesced
   progress snapshots; and
5. preserve the event as non-display, non-LLM state rather than sending a
   custom follow-up message to the model.

Appending a safe custom entry gives the supervisor a supported path from the
extension event bus to `session.subscribe()` and makes the latest state
recoverable from the Pi transcript. Do not append unbounded child output.
Only lifecycle changes and throttled progress snapshots are persisted.

The bridge must also handle the ordering edge case in the extension's smart
join mode: an agent can be created and finish during the debounce window
before a group ID is assigned. Start with the parent message as the grouping
key, then emit the finalized group association and let the supervisor replace
that grouping metadata.

## 1.3 Preserve existing extension behavior

- Keep the existing `subagents:record` and completion notification paths as
  compatibility fallbacks.
- Do not render the bridge's custom entries as duplicate chat messages.
- Do not require the bridge for todo, compaction, or unrelated extensions.
- Keep extension failures isolated: a telemetry failure must not stop a child
  agent or fail the parent turn. Report a bounded extension error through the
  existing extension-error path if useful for diagnostics.

## 1.4 Tests for changeset 1

Add unit tests for:

- created-before-started ordering and queued-to-running transition;
- terminal success, failure, cancellation, and aborted/steered mapping;
- group assignment arriving after agent creation;
- progress coalescing and bounded fields;
- redaction of bearer tokens, API keys, URLs with credentials, and control
  characters;
- ignoring unknown event channels and malformed payloads; and
- bridge no-op behavior when `pi-subagents` is not loaded.

Use a small fake event bus/extension context rather than loading the real
provider or making a model request.

# Changeset 2 — supervisor snapshot and SSE contract

## 2.1 Add a supervisor-owned activity store

Add a focused module, such as `server/subagent-activity.js`, for validation,
state transitions, grouping, and snapshot projection. Keep this separate from
the generic todo/compaction normalizer in `server/activity.js`.

Each attached real session gets a `Map<runId, SubagentActivityRecord>` and a
bounded group index. The store should:

- accept only a newer revision or a valid lifecycle transition;
- reject oversized/unknown payloads before they reach the browser;
- retain terminal cards for the lifetime of the transcript view;
- keep at most the configured bounded number of live/terminal records in the
  in-memory projection; and
- expose a deterministic sorted snapshot by parent message, group, and
  creation time.

`RealSupervisor` should update this store when the bridge's
`pi-web:subagent` entries arrive in `entry_appended`. It then emits the safe
record through `hub.emit(sessionId, "activity", { record })`. The store, not
`activityFromEntry()`, decides whether a new event replaces an existing run.

The existing final `subagents:record` entries should be normalized into the
same store during replay. Prefer the richer `pi-web:subagent` record when both
exist, and merge a later final result into the existing run ID.

## 2.2 Reconstruct snapshots and reconnects

Update `RealSupervisor.transcript()` / `entriesToRecords()` so a transcript
snapshot contains the latest safe activity record for every known run. The
existing sequence barrier in `GET /api/sessions/:id/transcript` remains the
reconnect contract:

1. capture the hub sequence;
2. build the transcript plus the supervisor's current activity snapshot;
3. return the sequence;
4. let the client replay buffered events with a higher sequence.

Use the existing EventHub sequence for wire ordering and the per-run
`revision` for idempotent replacement. Do not add a server replay buffer in
this phase.

On reattach, recover the latest durable lifecycle snapshot. Do not invent a
terminal result for a queued/running record whose process is no longer active.
If the runtime can prove that a recovered run is no longer live, represent
that as a failed/cancelled state with an honest bounded message rather than
silently dropping it.

Add `subagent-activity` to the advertised capabilities. Keep the existing
`activity` SSE event shape backward compatible; older clients may render a
simpler agent card while newer clients use the added fields.

## 2.3 Keep mock and real behavior comparable

Replace the mock's single canned completed agent with a deterministic scenario
that can exercise the UI contract:

- create two or more agents in one group;
- emit queued, running, and coarse progress updates;
- finish agents out of order, including one failure fixture; and
- persist the final records in the mock transcript.

The mock must remain clearly scripted (`source: "mock"`) and must not imply
that it performed real delegation. A prompt trigger or test-only supervisor
scenario is acceptable, but the event order must match the real contract.

## 2.4 Tests for changeset 2

Add tests covering:

- state replacement by run ID and revision;
- out-of-order/duplicate SSE updates;
- grouping before and after group finalization;
- snapshots containing queued, running, completed, and failed cards;
- terminal records replacing rather than duplicating running records;
- snapshot-plus-buffer reconnect behavior;
- real-supervisor handling of `pi-web:subagent` entries;
- compatibility with old `subagents:record` entries; and
- mock HTTP/SSE end-to-end parallel activity.

The existing activity tests should remain for todo and compaction behavior.

# Changeset 3 — grouped activity UI

## 3.1 Client state and event application

Update `public/js/api.js` and `public/js/store.js` to:

- apply agent activity records by `runId`/record ID and `revision`;
- retain completed and failed records instead of treating them as transient
  live-only panels;
- preserve activity records during history pagination;
- keep open/closed state keyed by group ID with a run-ID fallback; and
- use the existing reconnect path to replace the transcript from a snapshot
  before applying newer buffered events.

The existing turn lifecycle remains authoritative for the parent assistant
stream. Agent activity must not change `t.streaming` or cause a parent turn to
finish early.

## 3.2 Render one grouped parallel-work panel

Refactor `PiThread.renderActivity()` and the activity portion of
`renderRecord()` so agent records are rendered once, in a grouped panel rather
than once as a live panel and again as a completed inline block.

For each active parent turn:

- group by `groupId`, falling back to `parentMessageId` for ungrouped agents;
- show an aggregate header with counts for queued, running, completed, and
  failed/cancelled agents;
- render one compact row per agent with status icon, description, current
  activity, tool count, and client-computed elapsed time; and
- keep terminal summaries visible in the same group after completion.

Interaction rules:

- groups with running or failed agents open by default;
- fully completed groups collapse by default;
- the group and individual rows are keyboard accessible;
- status changes use a restrained `aria-live` aggregate announcement rather
  than announcing every progress tick; and
- activity text is escaped or sanitized through the existing Markdown path.

There is intentionally no child-chat link or expand-to-transcript action in
this changeset. A row may show a non-interactive “summary” area, but it must
not expose output files, session IDs, prompts, or raw tool payloads.

## 3.3 Styling and responsive behavior

Extend `public/app.css` using the existing activity surface tokens:

- distinguish the aggregate parallel-work header from the todo panel;
- use consistent queued/running/success/failure/cancelled colors and glyphs;
- keep descriptions and activity labels ellipsized without hiding status;
- make rows readable on narrow mobile widths; and
- avoid animation that implies progress when the server has not sent an
  update. The existing elapsed-time refresh may update the displayed duration.

Do not add a separate permanent sidebar in this phase. The activity remains
part of the transcript flow so users can see it in context with the parent
turn.

## 3.4 Browser and integration tests for changeset 3

Extend `test/dom.test.js` to verify:

- a group renders one aggregate header for multiple agents;
- queued/running/completed/failed states and counts are visible;
- updates replace the same row rather than duplicating it;
- completed cards remain after `turn_end`;
- out-of-order revisions do not regress a terminal card;
- group collapse/expand state is retained across re-render;
- descriptions and summaries are safe in the DOM; and
- mobile-width rendering keeps the status and description available.

Extend `test/server.test.js` to verify the mock SSE lifecycle and transcript
snapshot. Keep a real-supervisor fixture for entry replay, but do not make the
ordinary test suite depend on provider credentials.

## Acceptance gate

Run:

```sh
mise run check
```

Then perform a real-server click-through with a prompt that causes at least
two independent background agents:

1. verify a card appears while agents are still queued/running;
2. verify two cards remain visible concurrently;
3. verify progress labels and counts update without raw child output;
4. verify completion and failure are distinguishable;
5. refresh while work is active and after it completes;
6. verify reconnect does not duplicate cards; and
7. verify the parent assistant turn and ordinary todo activity still behave as
   before.

## Explicitly deferred

- child-session transcript APIs, drawers, or conversation viewers;
- stop, cancel, steer, retry, or resume controls;
- raw child assistant-text streaming;
- exposing output-file paths or Pi session IDs to the browser;
- token/cost display beyond a future safe aggregate;
- arbitrary extension widgets/renderers; and
- a permanent subagent fleet/sidebar view.
