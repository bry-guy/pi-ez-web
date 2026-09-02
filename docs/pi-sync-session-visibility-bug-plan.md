# pi-sync session visibility bug

Status: fixed in the supervisor/config replacement path; deployment validation remains.

## Symptom and impact

After a web session opens a synchronized conversation, the browser may show:

> Could not open the synchronized conversation: The synchronized conversation is not available locally.

The canonical JSONL transfer can already have succeeded. The failure happens
after the server emits `session_switched`: the browser refreshes `/api/state`,
cannot find the target session ID, retries once, and reports the misleading
error. The target can still exist on disk and be attached to the supervisor.

This affects the CLI-to-web path most visibly when the web session has been
moved between Git workspaces before it opens a canonical session.

## Root-cause trace

1. `vendor/pi-sync/extensions/sync.ts:630-680` creates the target below
   `ctx.sessionManager.getSessionDir()`, writes the canonical envelope, and
   calls `ctx.switchSession(target)`.
2. `server/supervisor/real.js:817-857` opens the target, replaces the live
   `AgentSession`, registers it, and emits `session_switched` with the target
   ID. It already records the target file in its internal path maps.
3. `public/js/api.js:377-389` receives the event, calls `refreshState()`, and
   asks `selectSessionById()` to find the target. If state discovery omitted the
   ID, it throws the reported error.
4. `server/supervisor/real.js:1067-1079` implements `rehome()` by changing the
   logical `cwd`/metadata. It does not move the existing Pi JSONL file to the
   new workspace's session directory. The route then records the source ID's
   project binding in `server/routes.js:623-628`.
5. `server/domain.js:58-91,111-121` discovers project sessions by calling
   `sup.listSessions(context.path)`. `server/supervisor/real.js:127-149`
   delegates that operation to `SessionManager.list(cwd)`, which does not find
   a replacement file left in the old physical session directory.
6. The replacement target has a pi-sync binding, but not a pi-ez-web project
   binding. The domain fallback can use `sup.meta(id)` for a known web binding,
   but it has no way to associate this new target ID with the project. The
   target is therefore absent from `/api/state` even though the live supervisor
   has opened it.

The same symptom can be produced independently if the target ID is present in
`closed.json`; closed sessions are intentionally filtered from visible state.
That case should remain hidden after the fix unless the replacement explicitly
reopens it.

## Deterministic reproduction

### Preconditions

- A real pi-ez-web server with the pi-sync extension enabled.
- A configured `pi-syncd` endpoint and a canonical session that can be selected
  from the same normalized Git repository.
- Two discoverable workspaces for one repository, `workspace-a` and
  `workspace-b`.
- For a local checkout, build the sibling pi-sync package and set
  `PI_WEB_SYNC_CLIENT_MODULE` as documented in `README.md`.

### Backend/test fixture

1. Create a web session in `workspace-a` and record `sourceId`.
2. Rehome that session to `workspace-b` through
   `POST /api/sessions/:sourceId/worktree` with `{ "branch": "..." }`.
3. Confirm `/api/state` reports the source session on `workspace-b`.
4. Keep the source session's physical JSONL in its original Pi session
   directory. Do not copy it into the directory normally scanned for
   `workspace-b`.
5. Make a canonical target available under a different `targetId` and run the
   real extension replacement path (`/sync` selection, materialization, and
   `switchSession`). A sync-server stub is sufficient if the test does not
   need a model turn.
6. Capture the `session_switched` event and check these conditions before
   refreshing state:

   - the target JSONL exists below the source session manager's session
     directory;
   - the supervisor has a live target session and can serve its transcript;
   - `targetId` is not present in `GET /api/state`.

7. Let the browser handle the event. `openSwitchedSession()` refreshes state
   twice, fails to select `targetId`, and stores the reported error.

Useful checks for a running instance are:

```sh
find "$PI_CODING_AGENT_DIR" -type f -name "*${TARGET_ID}.jsonl"
curl -s http://localhost:3141/api/state | jq --arg id "$TARGET_ID" '.. | objects | select(.id? == $id)'
curl -s http://localhost:3141/api/sessions/$TARGET_ID/transcript
```

Expected behavior is that the canonical transcript opens and `targetId` is
visible in the web project state. Actual behavior is that the file and live
session exist, the state query returns no target node, and the browser reports
that the conversation is unavailable locally.

### CLI-to-web variant

1. Attach a CLI Pi session in `workspace-a` with `/sync attach` and complete a
   turn so the canonical session has a current snapshot.
2. Start or select a web session, then move it to `workspace-b` with the web
   branch/worktree control.
3. In the web session, run `/sync` and select the CLI-created canonical
   conversation.
4. Observe the successful-looking materialization followed by the
   `session_switched` browser error.
5. Verify that the target JSONL can be found under the Pi session directory,
   while the target ID is absent from `/api/state`.

This variant demonstrates that the sync service and canonical transfer are not
the failing boundary.

## Remaining coverage

- `docs/pi-sync-integration-plan.md:156-159` still lists browser `/sync`
  selection and `switchSession` replacement as unfinished acceptance coverage;
  the DOM regression now covers the state-refresh boundary with a lightweight
  mock.
- The local supervisor/config tests cover replacement followed by project-state
  discovery after a workspace rehome. A real CLI/web run against a configured
  sync service and deployed image remains operational validation.

## Preferred solution

Fix the web-side replacement bookkeeping before changing the frontend retry
logic.

1. In `RealSupervisor._replaceLiveSession`, snapshot the source's
   pi-ez-web project binding before disposing the source session.
2. After the target is successfully opened and registered, inherit that
   binding under `targetId`. Preserve `projectId` and the workspace path; use
   the target cwd only when the source binding has no workspace path.
3. If `targetId` is already archived, remove it from the closed-session set as
   part of the successful replacement. Do not unarchive an unrelated target
   after a failed replacement.
4. Preserve the source's web binding and copy it to the target. The source and
   target are distinct conversation identities, and `_replaceLiveSession` is
   shared by resume, new-session, fork, and synchronized replacement paths.
   Leave the source JSONL and binding available for recovery; hiding it requires
   an explicit close/archive operation, not replacement bookkeeping.
5. Persist the binding and archive changes before emitting `session_switched`.
   If persistence fails, keep the source usable or dispose the target and
   return a controlled error; never emit an event that state discovery cannot
   satisfy.
6. Keep `domain.js`'s binding fallback for bound sessions. Do not replace
   project-scoped discovery with an unrestricted `SessionManager.listAll()`;
   that would risk exposing sessions from another project and duplicate nodes.
7. Do not fix this with more browser retries. Retries cannot make an
   unassociated target appear in `/api/state`.

The likely implementation belongs in the supervisor/config boundary because it
already owns replacement identity and is shared by `/sync`, resume, new-session,
and fork replacement paths. If the binding transfer is intentionally limited
to synchronized replacement, pass an explicit replacement option rather than
making the generic switch path infer sync state.

## Regression tests and acceptance criteria

### Backend integration test

Add a real-server test that:

- creates a session in workspace A;
- rehomes it to workspace B;
- creates or materializes a replacement target in the old physical session
  directory;
- performs the real replacement;
- asserts the target is present in `/api/state` with workspace B and an
  inherited project binding;
- asserts the source remains recoverable and its binding is preserved;
- asserts the target transcript remains readable.

Run the same assertion with a target ID that was previously archived and verify
that a successful replacement reopens it while a failed replacement leaves the
archive marker unchanged.

### Browser integration test

Change the DOM test so the initial state does not contain the target. Have the
mock `refreshState()` response add the target as the backend would after the
replacement bookkeeping completes. Apply `session_switched` and assert:

- the target is selected;
- no synchronization error is stored;
- the refresh path does not depend on a pre-seeded target node.

### CLI/web acceptance test

With one canonical session updated by the CLI, rehome the web session to a
second workspace, select the canonical session in the web `/sync` picker, and
assert that the transcript opens and the target appears in `/api/state`.

### Compatibility checks

- Same-workspace `/sync` selection still works.
- Refreshing the current synchronized session still preserves its binding.
- Closed sessions remain hidden unless explicitly reopened by replacement.
- Unbound local-only sessions remain local-only.
- A replacement failure does not lose the source binding or emit
  `session_switched`.

Live Kubernetes verification was not performed because this checkout had no
configured cluster context. The repro and fix should be validated against the
deployed image after the local tests pass.
