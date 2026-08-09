# Pi Web UI remediation implementation plan

Status: accepted with revisions from `~/Downloads/FIXPLAN.md`.

This plan is the implementation contract for the remediation work. It preserves
the fixplan's phase order where useful, but rejects a few implementation details
that are not sufficient for the SDK and current wire contract.

## Decisions

| Proposal | Decision | Ruling |
| --- | --- | --- |
| Phase 1: remove modal `stopPropagation()` | **Accept** | The scrim-target checks are sufficient. Remove both inline handlers and add browser assertions for every modal action. |
| Phase 2.1: cache real-session cwd and recover it with `SessionManager.open().getCwd()` | **Accept with additions** | Cache `SessionInfo`/paths as a discovery index, use `getCwd()` on a miss, and overlay `bindings.json`. Never fall back to `path.dirname(sessionFile)`. Add an explicit investigation/gate for detecting Pi CLI sessions in `activeInCwd`; do not claim T-022 is covered by live in-process sessions alone. |
| Phase 2.2: client-supplied record IDs echoed through `turn_start` | **Reject as written; Amendment A accepted** | `user_record` from `entry_appended` is the only user-message event in both modes. A client ID may be used only as an internal optimistic-reconciliation key; Pi entry IDs remain canonical. Remove `turn_start.userRecord` from the contract, mock, and tests. |
| Phase 2.3: stable IDs from `SessionManager.getEntries()` plus sequence resume | **Accept with correction** | Use the current branch (`getBranch()`), not every historical branch in `getEntries()`. Add a sequence snapshot and buffer barrier, and define deterministic IDs for live assistant records before their final JSONL entry is persisted. |
| Phase 2.4: rewind fork with the selected entry's `parentId` | **Accept with edge cases** | Navigate to the parent entry; use `resetLeaf()` for a root user entry; resolve only canonical user-entry IDs and test synthetic/non-user records. |
| Phase 2.5: top-level queue fields | **Accept** | Map `evt.steering` and `evt.followUp`. |
| Phase 2.6: amend the spec if custom bang persistence is unavailable | **Reject** | The installed SDK exposes `SessionManager.appendCustomEntry()`. Implement real bang persistence as a custom entry and render it from snapshots. Do not amend T-050/T-041 to preserve a known divergence. |
| Phase 3.1: model runtime/list endpoint | **Accept with SDK correction** | Use `session.modelRuntime.getAvailable*()` / `getModel()`, or construct `new ModelRegistry(session.modelRuntime)`. `ModelRegistry.create()` does not exist. Wire default models into new sessions and expose the selected model per session, not as one global client value. |
| Phase 3.2: imperative search/filter rendering | **Accept** | Preserve the input node, value, selection, and focus; re-render only result regions. |
| Phase 3.3: `filesKey = projectId:branch` | **Reject as insufficient** | Include the actual workspace path or explicitly invalidate on merge/re-home. A branch can retain its name while its workspace path changes. |
| Phase 3.4: clear busy state on the occupying session's `turn_end` | **Accept with reconnect cleanup** | Clear all references to that session and reset stale ephemeral busy state after transcript resnapshot/reconnect. Resolve its title from state. |
| Phase 4.1: refuse dirty-checkout forks | **Accept** | The checkout is sacred. Return `409 checkout_dirty`; update T-023/PLAN/docs because the current spec still requires stash transfer from every dirty parent. Retain hardened stash transfer only for app-owned worktree parents. |
| Phase 4.2: filter projects and auto-expand matches | **Accept** | Match project name or descendant session titles; keep unrelated projects out of the result. |
| Phase 4.3: splice closed nodes out of the tree | **Accept with fallback** | Preserve closed nodes while building the tree, splice their children at their position, and handle consecutive closed ancestors. Add a persisted-lineage fallback for parents no longer discoverable in a live worktree. |
| Phase 4.4: add `role=button`/`tabindex` to `[data-act]` | **Accept the goal, revise the scope** | Several interactive elements use `data-repo`, `data-dir`, `data-project`, or `data-toggle`, not `[data-act]`. Cover every clickable custom row/card/header, prefer native buttons where practical, and add Enter/Space behavior plus `aria-expanded` for toggles. |
| Phase 4.5: one composer hint for all errors | **Revise** | Use the existing surface appropriate to the failure: composer error for send/fork/bang, file-panel error for file loading, modal/confirm callout for repo/lifecycle actions, branch popover error for branch actions. Add the reload prompt for contract mismatch. |
| Phase 4.6: README trust warning | **Accept** | Add the explicit no-auth/no-sandbox LAN/VPN-only warning. `docs/implementation.md` is present in this checkout; if a downstream tree lacks it, update the available implementation documentation without inventing a duplicate. |
| Phase 4.7: promote the DOM harness and checklist | **Accept** | Add a maintained DOM suite to `npm test`, an optional real-browser pass, and a shipped click-through checklist. Keep credentialed `verify:real` explicit rather than part of the default no-credential check. |
| Wordmark/indent ruling | **Accept** | Follow the latest written `SPEC-UI`: wordmark weight 500 and 13px-per-level tree indentation. The prototype conflict is lower authority. |
| Real bang fallback spec amendment | **Reject** | Custom entries are available in the installed SDK, so implement persistence. |

## Phase 0 — lock the SDK and wire-contract assumptions

Before changing behavior:

1. Extend `test/sdk-surface.test.js` to assert the exact surfaces used by the
   remediation:
   - `SessionManager.getCwd`, `getEntries`, `getBranch`, `getEntry`,
     `appendCustomEntry`, `getLeafId`, and `resetLeaf`/branch support.
   - `AgentSession.modelRuntime`, `sessionManager`, and the `entry_appended`
     event shape.
   - `ModelRuntime.create`, `getAvailableSnapshot`, `getAvailable`,
     `getModel`, and `getProviders`.
   - `SessionManager.appendCustomEntry` plus the SDK writer used to flush a
     new session containing only a bang; this is the one chosen
     bang-persistence path.
2. Add focused adapter tests for SDK session entries and model references. Do
   not implement against an inferred `ModelRegistry.create()` API.
3. Add `EventHub.currentSeq()` (or an equivalent atomic snapshot method) and
   document the transcript response extension `{ records, streaming, seq }`.
4. Decide and document the canonical record identity rules:
   - user records: Pi session-entry IDs;
   - tool calls: Pi tool-call IDs;
   - bang records: the persisted bang ID stored in the custom entry;
   - assistant records: deterministic IDs derived from the current entry-parent
    /turn position, with a live-session identity map so an in-flight snapshot
    and its replay use the same ID.

## Phase 1 — unblock all client lifecycle actions

Files: `public/js/panels.js`, DOM tests, Playwright smoke script.

1. Delete both inline propagation-stopping handlers.
2. Keep dismissal restricted to the scrim target.
3. Exercise through the UI, not only by invoking APIs:
   - repo picker close and repository selection;
   - close confirmation Go back and CTA;
   - merge confirmation Go back and CTA;
   - error responses remaining visible in the relevant dialog.

Gate: the five currently failing D-01 action checks pass, plus a real
Chromium click-through confirms that project creation, close fallback, and
merge state changes occur without directly mutating store state.

## Phase 2 — real supervisor identity, cwd, and transcript correctness

Files: `server/supervisor/real.js`, `server/events.js`, `server/routes.js`,
`server/domain.js`, `server/supervisor/mock.js`, `public/js/api.js`,
`public/js/thread.js`, `public/js/store.js`, SDK/HTTP tests, and
`scripts/verify-real.js`.

### 2.1 Session discovery and cwd

- Maintain a per-ID discovery record containing session path, recorded cwd,
  parent-session path, and metadata returned by `SessionManager.list()`.
- For empty/old `SessionInfo.cwd`, open the session manager and call
  `getCwd()`; never derive cwd from the JSONL file's parent directory.
- On cold attach, use the discovered cwd as `cwdOverride`; then apply an
  explicit `bindings.json` re-home.
- Ensure `meta()`, `transcript()`, `message()`, `stop()`, `setModel()`, and
  fork all use the same resolved workspace.
- Add a test for server restart with a session born in one workspace and a
  binding re-homed to another.
- Timebox the T-022 external Pi CLI investigation to one working day. If the
  SDK exposes no reliable cross-process active-turn signal—and no cooperative
  lease can be honored by Pi CLI—amend T-022 to scope the turn lock to
  app-managed sessions and document external-CLI concurrency as user-managed.
  Do not let this investigation stall the rest of Phase 2.
- Verify the ordering assumption that `entry_appended` fires when a
  steer/follow-up is delivered in the credentialed `verify:real` gate, not in
  the no-credential SDK-surface gate.

### 2.2 Live user records

- Subscribe to `entry_appended` and identify user `message` entries from the
  SDK entry shape.
- Emit one canonical `user_record` event for every user message, including the
  initial prompt, steer, and follow-up delivery. Remove `userRecord` from
  `turn_start` entirely; the mock emits the same single event path.
- If optimistic rendering is retained, send a temporary client ID only as an
  internal correlation key. Replace the temporary record when the canonical
  event arrives; never persist the temporary ID as the real record ID. Remove
  it on a rejected request.
- Cover prompt, steer, follow-up, and busy-rejected sends in mock integration
  tests.

### 2.3 Stable snapshots and sequence barriers

- Convert `SessionManager.getBranch()` entries into the five-role UI records,
  preserving Pi IDs and custom bang entries. Do not expose abandoned sibling
  branches in the active transcript.
- Include the hub sequence captured at the start of snapshot construction.
- During `openTranscript()`, install the per-session buffer before fetching,
  keep all events buffered until the snapshot is installed, then replay only
  events with `seq > snapshot.seq`.
- On SSE reconnect, enter this buffering mode immediately rather than waiting
  for a delayed timer while live events are applied to the old snapshot.
- Preserve in-flight records from the attached supervisor state when Pi has
  not appended their final JSONL entries yet. Test that a mid-turn snapshot
  and replay do not duplicate or lose text.

### 2.4 Fork and entry mapping

- Resolve `atRecordId` to a canonical user entry in the forked session.
- Use that entry's `parentId` as the fork leaf. For a root entry, reset the
  leaf rather than passing `null` to `navigateTree()`.
- Preserve the existing code/worktree fork behavior, but return and surface
  `checkout_dirty` before any stash operation.
- Add tests for root, middle, last-user-message, and invalid/non-user fork IDs.

### 2.5 Queue and bang persistence

- Map queue counts from top-level `steering` and `followUp` arrays.
- Append a `pi-web:bang` custom entry containing the stable bang ID, command,
  exit status, duration, and output. Map this custom entry in cold snapshots.
- Keep live bang events idempotent with the custom-entry snapshot.

Gate: updated SDK-surface tests, mock snapshot/resume tests, and an expanded
credentialed `verify:real` that checks:

- correct cwd after restart and re-home;
- live prompt visibility for prompt, steer, and follow-up;
- identical IDs across repeated snapshots;
- mid-turn reconnect without duplicate/lost records;
- fork truncation before the selected user message;
- non-zero queue counts;
- persisted real bang records;
- model listing and model application.

## Phase 3 — models and P1 client behavior

### 3.1 Models

Files: supervisor implementations, routes, config/domain state, `api.js`,
`store.js`, `shell.js`, `thread.js`, settings panel, tests.

- Add `listModels()` and `defaultModel()` to both supervisors.
- Real mode uses the session's `modelRuntime` and its available model APIs;
  model references are `provider/modelId` and are resolved to real model
  objects before `session.setModel()`.
- Mock mode exposes a small explicit list such as `mock/fast` and
  `mock/smart`.
- Add `/api/models` and include the list in `/api/state`.
- Pass the configured default model into newly created chats/projects, with a
  clear fallback/error if it is unavailable.
- Store model metadata per session (not one global `store.state.model`). Add
  either a session metadata endpoint or model fields to state nodes, and update
  the selected session when `session_meta` arrives.
- Validate settings against the available model references.

Gate: API/model tests prove registry-backed values; DOM tests prove the chip
and settings cycle the returned list and that switching sessions shows each
session's actual model.

### 3.2 Focus-preserving filters

Split sidebar and repo-picker rendering into stable input containers and
replace only result lists. Preserve selection range for programmatic updates.
Test typing at least three characters, caret-at-end and caret-in-middle, and
filtering while an SSE state refresh occurs.

### 3.3 File-panel invalidation

Track a context key containing project, session/workspace path, and branch.
Clear `store.files` before a project/workspace change and refetch whenever an
open panel observes a changed key, including branch switch, merge, and
re-home. Surface fetch errors in the file panel.

### 3.4 Busy lifecycle

On any `turn_end` for session `Y`, clear every `busy[X] === Y`. Clear or
reconcile stale busy entries after a transcript resnapshot. Resolve `Y`'s
current title recursively and render `branch busy in <title>`.

Gate: DOM and mock integration tests cover collision, successful completion,
stop/error completion, SSE reconnect, and title rendering.

## Phase 4 — correctness, safety, accessibility, and honest failures

### 4.1 Dirty-checkout fork refusal

- Detect the checkout parent before `git stash` and throw `checkout_dirty`.
- Map it to HTTP 409 and a composer/inline error.
- Retain stash transfer only for app-owned worktree parents.
- Make the stash marker unique, capture the exact stash object, apply/drop
  that object rather than assuming `stash@{0}`, and add startup diagnostics for
  stranded `pi-web-ui` markers.
- Update `PLAN.md`, `docs/implementation.md`, README, and the written spec
  decision so documentation no longer promises dirty checkout forks.

### 4.2 Project-aware search

Filter project rows by project name or any matching descendant session. Auto-
expand matching projects only while a query is active; preserve the user's
manual tree state when the query clears.

### 4.3 Tree re-parenting

Build the complete discovered lineage with closed markers, remove closed nodes
from the visible tree, and splice their children into the parent's ordered
children. Walk through multiple closed ancestors. Add coverage for a closed
middle node, closed root, consecutive closed nodes, and a missing/reaped
ancestor.

### 4.4 Keyboard access

Use native buttons for new interactive markup where possible. For remaining
custom rows/cards/headers/directories/repo rows:

- add `role="button"`, `tabindex="0"`, and appropriate `aria-*` state;
- delegate Enter and Space to the existing click path;
- make collapsed/expanded controls expose `aria-expanded`;
- add visible `:focus-visible` styles without relying on browser defaults;
- exclude inert files and disabled occupied branches from the tab order.

Add a browser keyboard sweep rather than only checking attributes.

### 4.5 Error surfaces and contract mismatch

Add a shared transient error state with a timer, but render it in the surface
appropriate to the action. Replace console-only catches for fork, bang, send,
file load, repo load, and lifecycle actions. On an unknown SSE contract version,
replace the app body with a centered reload prompt and stop applying events.

Also fix the D-12 first-turn title: update a `New session` title immediately
from the first canonical user record and reconcile it from `/api/state`.

### 4.6 Fidelity and security documentation

- Change the wordmark to weight 500.
- Change session/file indentation to 13px per level where the current CSS uses
  the prototype's 14px + 12px calculation.
- Add the explicit trust warning: no auth, no sandbox, shell runs as the
  service user, LAN/VPN only, never port-forward.

### 4.7 Verification gate

- Promote the DOM harness to `test/dom.test.js` and add its required jsdom
  development dependency without adding client runtime dependencies.
- Keep `npm test` credential-free and make it run server, SDK-surface, DOM,
  lifecycle, and workspace tests.
- Add an optional Playwright browser script and ship `CHECKLIST.md` for the
  visual/click-through pass.
- Keep credentialed `npm run verify:real` explicit; add a `mise verify` alias
  if useful, but do not make credentials mandatory for `mise check`.
- Document which gates were run in README before calling the deployment ready.

## Expected implementation surface

Likely files include:

- `server/supervisor/real.js`, `server/supervisor/mock.js`,
  `server/supervisor/index.js`;
- `server/events.js`, `server/routes.js`, `server/domain.js`,
  `server/workspaces.js`, `server/config.js`;
- `public/js/api.js`, `store.js`, `shell.js`, `thread.js`, `panels.js`,
  `main.js`, and `public/app.css`;
- `test/sdk-surface.test.js`, new record/model/domain/DOM tests,
  `scripts/verify-real.js`, `package.json`, `package-lock.json`, `mise.toml`;
- `README.md`, `PLAN.md`, `docs/implementation.md`, and `CHECKLIST.md`.

No implementation code is changed by this plan. Completion requires the
credential-free suite, browser click-through, and credentialed real-Pi gate to
pass independently.
