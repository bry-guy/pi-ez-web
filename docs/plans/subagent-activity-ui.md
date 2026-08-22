# Subagent activity UI

Status: implemented

## Goal and scope

Show parallel background-agent work in the transcript flow without exposing child
prompts, tool arguments, paths, raw output, or secrets. The first version is
read-only: child transcript drawers and stop/steer/retry controls are deferred.

## Public record contract

Each agent projection is bounded and identity-stable:

- `runId`, `groupId`, and `parentMessageId` identify the run and parallel turn;
- `status` is one of `queued`, `running`, `completed`, `failed`, or `cancelled`;
- `revision` orders updates monotonically;
- timestamps support duration display;
- `title`, `activity`, `toolCount`, `summary`, and `error` are bounded safe
  projections.

The normalizer redacts credentials and control characters before a record can
reach the transcript, SSE hub, or browser.

## Ownership and lifecycle

`server/extensions/subagent-telemetry.js` is a headless bridge for the
lifecycle event bus exposed by `pi-subagents`. It filters nested agents,
throttles progress, captures the stable parent turn, and delegates event
merging and revision decisions to `SubagentActivityStore`.

`server/subagent-activity.js` is the canonical lifecycle/revision store. Its
`applyEvent()` method handles sparse, duplicate, reordered, and terminal
updates; `apply()` handles already-normalized transcript recovery records.
Terminal state cannot regress to live state or change from completed to failed
(and vice versa). The bridge and supervisor use the same store contract rather
than maintaining independent lifecycle truth.

Transcript custom entries are the durable recovery input. The real supervisor
seeds its store from the branch, emits accepted live updates over the existing
`activity` SSE event, and overlays store snapshots during reconnects and
transcript reads. The mock supervisor emits the same lifecycle shape for tests
and local UI work.

## UI behavior

- Running and queued agents appear in grouped, collapsible `Parallel work`
  panels at the bottom of the active transcript.
- When a group has no live agents, its terminal records leave the live panel and
  render as compact activity entries at their original transcript position.
- Completed, failed, and cancelled work therefore remains recoverable history
  without permanently growing the live activity surface.
- Todo and context-compaction activity retain their existing behavior.

## External package boundary

The bridge consumes lifecycle events available in current
`@tintinweb/pi-subagents` releases and accepts an optional
`subagents:progress` event for richer live labels and tool counts. The web app
does not vendor or monkey-patch that package.

## Validation

Coverage includes normalization/redaction, lifecycle ordering, duplicate and
terminal handling, bridge filtering, supervisor recovery, SSE snapshots, mock
parallel runs, and DOM behavior. The project gate is `mise run check`.

## Deferred work

- child transcript viewing;
- stop, steer, retry, and other controls;
- richer child tool telemetry when the external package exposes it consistently.
