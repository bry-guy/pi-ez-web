# pi-sync integration plan

Status: active implementation plan; pi-sync has been released and this branch contains the adapter scaffold only.

## Context

The cross-device conversation design moves canonical enrolled sessions into the
standalone `pi-syncd` service. Pi continues to execute locally: pi-ez-web runs
models and tools against its server workspaces, while CLI clients run against
their laptop workspaces. An exclusive renewable lease guarantees that only one
runtime may update an enrolled conversation.

The sibling `pi-sync` repository owns the Go service, protocol, reusable
TypeScript client, native JSONL adapter, CLI extension, and synchronized
workspace skill. This repository owns only the pi-ez-web adapter and user
experience. The selfhost `infra` repository deploys the service and supplies the
tailnet route and persistent storage.

The standalone pi-sync service and reusable client are now released. This
branch deliberately records the remaining pi-ez-web adapter work as a plan; it
does not claim that the current coordinator is production-capable until the
released client is pinned and the supervisor lease boundary is implemented.

For the personal deployment, all web conversations will be synchronized. The
application also supports manual per-conversation enrollment so the upstream
self-hosted default does not require a sync server.

## Configuration and state

Extend `server/config.js` with:

```json
{
  "sync": {
    "serverUrl": null,
    "allConversations": false
  }
}
```

Support `PI_WEB_SYNC_SERVER_URL` and
`PI_WEB_SYNC_ALL_CONVERSATIONS` as read-only deployment overrides. A missing
URL disables the adapter without changing existing local behavior. The
selfhost production deployment supplies both overrides; local and third-party
installs remain manual until configured.

Persist successful manual enrollment IDs in an atomic file under
`PI_WEB_HOME`, for example `sync-sessions.json`. Once marked enrolled, the
remote snapshot is canonical. Do not mark an ID until `POST /v1/sessions`
succeeds. `allConversations` treats every discovered session as enrolled and
uses the local file only to track pending initial enrollment failures.

Use the native Pi session ID as the sync session ID. Keep lease tokens and ETags
in memory while a web operation is active; pi-ez-web reacquires and receives the
canonical ETag before every later mutation.

## Adapter boundary

Add a host-level coordinator rather than loading the CLI extension into each
web AgentSession:

```text
server/sync/client.js          wrapper around the pi-sync TypeScript client
server/sync/coordinator.js     enrollment, lease, heartbeat, pull/push lifecycle
server/sync/session-files.js   canonical envelope to local JSONL materialization
server/sync/workspace.js       upstream Git pointer derivation
```

Pin the reusable `pi-sync` npm package at build time. The coordinator is the
only module allowed to communicate with `pi-syncd`; routes and the supervisor
call it through a narrow interface.

The coordinator API should expose operations shaped like:

```text
status(sessionId)
enroll(sessionId)
prepareMutation(sessionId)
commitSettled(sessionId)
commitAndRelease(sessionId)
release(sessionId)
```

`prepareMutation` acquires the remote lease, starts its heartbeat, receives the
canonical envelope and ETag, materializes it using the web session's current
workspace binding, invalidates any stale supervisor runtime, and then permits
attachment. `commitSettled` serializes the current manager with its active leaf
and updates the remote snapshot using the held token and ETag.

## Supervisor coordination

Refactor `server/supervisor/real.js` so an enrolled session cannot be attached
for mutation until the coordinator has prepared it.

Required behavior:

1. An external `423 Locked` result prevents prompt, steering, compaction,
   navigation, model/session metadata changes, and other durable Pi mutations.
2. Before installing a downloaded snapshot, unsubscribe and dispose any idle
   cached `AgentSession` for that ID.
3. Never replace a local file while its AgentSession is streaming.
4. Materialize through a temporary sibling and atomic rename, then attach a new
   manager and restore the envelope's `headEntryId` with Pi's navigation API.
5. Start heartbeat renewal when the web mutation acquires the lease.
6. Keep the lease through retries, compaction retries, follow-ups, steering,
   and abort handling until the run reaches `agent_settled`.
7. On settlement, upload the complete normalized session and release.
8. For an idle one-shot mutation, upload and release immediately after the
   mutation completes.
9. If heartbeat renewal becomes uncertain, allow the in-flight run to settle
   locally but do not accept another mutation until the coordinator has
   reacquired against the unchanged ETag.

Create one supervisor invalidation method rather than reaching into its `live`
map from routes. Update metadata and session discovery caches after every
materialization or successful remote commit.

Inventory the existing route/supervisor mutation methods and put the lease
boundary beneath them so browser code cannot accidentally bypass it. Read-only
state and the last materialized transcript remain available while another
client owns the lease; the latest remote transcript is loaded when web next
acquires the session.

## Enrollment

### Individual enrollment

Add a conversation action, `Synchronize this conversation`. It is available
only when a sync server is configured and the session is idle.

The server action:

1. Discovers the native session and current head.
2. Derives the upstream Git pointer when the workspace has one.
3. Normalizes and validates the envelope through the shared client library.
4. Creates it on `pi-syncd`.
5. Persists the enrollment ID locally only after success.
6. Releases the creation lease after the initial upload.

Enrollment is one-way in this implementation. The UI reports an enrolled
conversation but does not offer removal.

### Synchronize all

Add a Settings control backed by `sync.allConversations`. Enabling it starts an
observable reconciliation pass over existing sessions:

- Enroll idle sessions not present on the server.
- Defer streaming sessions until they settle.
- Record and display failures without blocking application startup.
- Enroll each newly created chat or project session before its first mutation.

For the selfhost deployment this value is enabled declaratively. The startup
reconciler must remain idempotent and must never overwrite an already-enrolled
remote session after a duplicate-ID response.

## Workspace pointer

The adapter sends only the committed and pushed upstream state:

```json
{
  "gitRemote": "...",
  "branch": "upstream-branch",
  "commit": "upstream-commit"
}
```

Derive it from the session workspace's configured upstream. Local dirty state,
local-only commits, worktree paths, and stash state do not enter the sync
envelope. If no upstream exists, omit the workspace pointer while continuing
to synchronize the conversation.

When a remote snapshot is materialized on pi-ez-web, resolve its Git remote to a
configured project and existing branch-backed workspace. Require the selected
workspace to represent the recorded remote and make the recorded commit
available through normal Git workflow before permitting the next mutation.
Do not transfer patches or mutate Git automatically inside the sync adapter.

Make the `synchronized-workspace` skill from the pinned `pi-sync` package
available to web AgentSessions without loading the package's CLI extension.
Before a synchronized run, add a concise context note with the upstream branch
and commit and direct the agent to the skill. The skill establishes that code
moves only after a coherent commit and push.

## API and browser state

Extend `/api/health` and `/api/state` with a versioned sync capability and
connection status. Session rows need only:

```json
{
  "synchronized": true,
  "syncState": "available | in_use | pending | error",
  "leaseHolder": "macbook"
}
```

Expose app-owned endpoints for enrollment and Settings changes. Browsers never
receive a syncd lease token and never call syncd directly.

When a mutation is blocked by an external lease, return `423` with a stable
application error code and display the holder label and expiry. Update SSE/state
notifications when enrollment, lease ownership, or commit status changes so
open tabs converge without reloading.

## Tests

### Unit and integration

- Configuration normalization and environment precedence.
- Manual enrollment persistence and idempotent all-session reconciliation.
- Git upstream pointer derivation without dirty/local-only state.
- Supervisor disposal before materialization.
- Route-level `423` behavior for every durable mutation family.
- Heartbeat across a long mocked stream and release at `agent_settled`.
- Reacquisition after syncd restart when the ETag is unchanged.
- Stale ETag preservation without local or remote overwrite.
- Different web/CLI `cwd` values and parent-session normalization.
- Extension skill loading without the CLI sync extension.

Use an in-process fake sync client for most server tests and a real temporary
`pi-syncd` in one end-to-end gate.

### Browser

Add DOM coverage for the per-conversation action, Settings control, pending and
locked states, and stable error messages. Add one browser integration test that
enrolls a web session, observes a simulated CLI lease, waits for release, and
continues the same session.

## Delivery sequence

The first two scaffold steps are present in this branch. The remaining work is
intentionally ordered behind the released pi-sync client:

1. Pin the released `@earendil-works/pi-sync` package in the production image
   and implement the network client/coordinator boundary.
2. Add real enrollment, lease acquisition/renewal, ETag-aware settlement, and
   release behavior while preserving the fake coordinator for unit tests.
3. Add supervisor preparation, invalidation, heartbeat, settlement upload, and
   lease enforcement around all durable mutations.
4. Add all-conversations reconciliation and new-session enrollment.
5. Add Git upstream pointer and synchronized workspace skill context.
6. Run the real web-to-CLI-to-web end-to-end test against the released service.
7. Enable the production setting only after the standalone service rollout and
   selected-session migration pass.

The production deployment must start with `PI_WEB_SYNC_ALL_CONVERSATIONS=false`.
Only the later rollout step changes it to `true`; local and third-party installs
remain unchanged when no sync URL is configured.

Keep the adapter behind the configured server URL until the rollout is proven;
unenrolled sessions must continue to behave exactly as they do today.
