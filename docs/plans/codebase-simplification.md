# Codebase simplification and correctness plan

Status: approved, implementation underway on `feature/codebase-simplification` · Source: audit of `main` @ `ffb5499`

The user-approved closeout groups the remaining work into cohesive local batches: merge/deletion, worktree/stash transfer, then the original R1–R5 refactors. One implementation owner, one independent exact-diff review and one integrated full suite per batch replace the original per-ticket PR/worktree ceremony below; ticket scope and safety/visual acceptance requirements remain unchanged. No publishing, production deployment or merge to `main` is included. Preserve Playwright for browser validation.

The [current checklist](codebase-simplification-progress.md) records done and remaining scope. Keep logical move commits small and boring.

## Ground rules (read before starting)

1. **One ticket = one PR.** Branch name: `chore/<ticket-id>-<slug>` (e.g. `chore/c1-isdirty-fail-closed`).
   PR title uses Conventional Commits (`fix:`, `chore:`, `refactor:`).
2. **No behavior changes in refactor tickets (R*).** Move code; don't "improve" it on the way.
   If you spot a bug, write it down in the PR description and file it separately.
3. **Every PR must pass `npm test`.** Paste the final `# pass / # fail` lines into the PR.
4. **Correctness tickets (C*) need a regression test** that fails before your fix and passes after.
   Say in the PR how you checked it failed first.
5. **Deletions:** before deleting anything, prove it's unused:
   `grep -rnw <name> server public test scripts docs Dockerfile mise.toml .github` and paste the output.
6. **UI-touching tickets** must include before/after screenshots at 375×667 (iPhone 8) and 1280×800,
   dark and light. Run the mock server: `npm run dev` (port from `PORT`, default in `server/index.js`).
7. **Don't touch** deployment/infra, credentials, `vendor/pi-sync` source, or production config.
8. Ask in the PR if a requirement is ambiguous. Don't guess on data-loss paths.

## Suggested split

| Dev | Track | Tickets |
|---|---|---|
| A | Server correctness | C1 → C2 → C3 → C5 |
| B | Frontend correctness + cleanup | C4 → C6 → D2 → D3 |
| C | Deletions + hygiene | D1 → D4 → D5 → H1 → H2 |
| D (or A/B after) | Refactors | R1, R2, R3, R4, R5 (sequential within a file) |

C-track first; D/H can run in parallel with C; R tickets start after C1–C4 merge
(they touch the same files and would conflict).

---

## C — Correctness (do first)

### C1. `isDirty()` must fail closed — **highest priority, data-loss risk**
- **Where:** `server/workspaces.js` `isDirty()` (~line 232). Callers: `workspaces.js` `removeWorkspace` (~576),
  `forkWorkspace` (~603), `lifecycle.js` (~78, ~128), `routes.js` pull route (~1063), `workspaces.js` ~178.
- **Problem:** returns `false` when `git status` throws, so a Git failure is treated as "clean" and
  worktree removal can delete uncommitted work.
- **Do:** make `isDirty()` throw `Object.assign(new Error("git_status_unavailable"), { code: "git_status_unavailable", detail })`
  on failure (copy the shape from `assertCleanCheckout` in the same file). Make sure each route caller maps that
  code to an HTTP error (409 or 503) instead of a 500 with a stack trace.
- **Accept:** use a disposable real worktree with a failed Git status to assert the non-force operation rejects and its files survive. Preserve explicit force behavior. Verify existing removal safeguards before claiming a reproduced data-loss case.

### C2. Closed-sessions file: only "missing" means empty
- **Where:** `server/config.js` `loadClosed()` (~285) and the rollback block (~344).
- **Do:** in `loadClosed`, return an empty set only for `ENOENT`; rethrow other read/parse errors.
  In the rollback, don't swallow restore errors: collect them and rethrow (or attach to the original error as `cause`).
- **Accept:** tests: (a) missing file → empty set; (b) invalid JSON → throws; (c) a subsequent close does not overwrite
  the corrupt file.

### C3. Concurrent `closeSession` must not lose closes
- **Where:** `server/lifecycle.js` `closeSession` (~51).
- **Do:** compute `descendantsOf(...)` first, *then* `loadClosed()` → add → `saveClosed()` with no `await` in between.
- **Accept:** test fires two `closeSession` calls concurrently (use a mock `sup` whose descendant lookup awaits a
  manually-resolved promise) and asserts both IDs end up in `closed.json`.

### C4. `session_closed` must not clobber a newer selection
- **Where:** `public/js/api.js` `applyEvent`, `case "session_closed"` (~654).
- **Do:** inspect the actual selection identity helper and refresh behavior; after `await refreshState()`, do not change a newer selection. Guard identity, not a guessed API name.
- **Accept:** DOM test in `test/dom.test.js` (add a **new** `test(...)` block, don't extend the giant one): select A,
  emit `session_closed` for A, select B before the refresh resolves, assert B is still selected.

### C5. GitHub device-login races
- **Where:** `server/github.js` `start()` (~299) and `poll()` (~327).
- **Do:** set `activeId` (reserve the flow) **before** the first `await` in `start()`; a second `start()` while one is
  pending returns the existing flow or 409. In `poll()`, re-check that the flow wasn't cancelled immediately before
  saving the token.
- **Accept:** tests with a stubbed HTTP layer: two parallel `start()` → one device flow; cancel during account
  validation → no token written.

### C6. Don't lose typed input on re-render
- **Where:** `public/js/panels.js` `PiSettings.render` (~391) and the extension-UI component (~1792).
- **Do:** keep in-progress field values in a per-component draft object (keyed by request ID for extension UI) and
  render inputs from the draft. Clear the draft on successful submit only. Use `setHTML` from `store.js` so unchanged
  markup isn't replaced.
- **Accept:** DOM test: type into a field, trigger `store.notify("state")`, value, focus and caret are unchanged; failed submit keeps the value. Reset drafts on successful section save, cancellation/reopening, and extension request identity changes as appropriate. Separate settings and extension UI implementations. Screenshot not required (no visual change).

---

## D — Deletions (low risk, parallel with C)

### D1. Remove unused code

Delete (after the grep proof from rule 5): `operationResult` (`server/operations.js`), `resolveContext` and
`piWebStashes` (`server/workspaces.js`), `fileExplorerLimits` (`server/file-explorer.js`), `validateRepositoryPath`
(`server/repositories.js`), `showCompletedOperation` (`public/js/operations.js`), and the empty `reconcileBindings`
(`server/domain.js`) plus its call in `routes.js` `/state`.
- **Accept:** `npm test` green; PR lists each symbol with its grep output.

### D2. Remove the frontend animation timer and dead state
- `public/js/store.js`: delete `animIdx` and the `setInterval(... notify("anim") ...)` at the bottom.
  Remove `"anim"` handling from subscribers (`grep -n '"anim"' public/js`).
- Remove frontend `hookResult` (state field, resets in `shell.js`/`panels.js`, related CSS). **Keep** `server/hooks.js`.
- **Accept:** `npm test` green; no `anim`/`hookResult` left in `public/`.

### D3. Remove the dead workspace-settings modal
- `workspaceSettingsOpen` is never set to `true`. Remove the state, its Escape/scrim/close handlers, and the CSS block
  (`public/app.css` ~977–1021) plus any selectors only it uses. **Keep** the header "workspace settings" button — it
  opens the session picker and must still work.
- **Accept:** screenshots per rule 6; header button still opens the session picker (click it in the mock).

### D4. Remove unused design and doc files

- Delete `design/revision-1/` (its `support.js` is byte-identical to revision-2). Update links in `design/README.md`.
  Keep `design/revision-2/` (`mise.toml` opens its standalone prototype).
- Delete `docs/archive/` and `docs/production-backed-preview-plan.md` (both marked superseded). Fix the links in
  `docs/implementation.md`.
- For `docs/plans/repository-and-provider-tickets.md`, `auth-session-and-picker-follow-up.md`, `pi-sync-web-refresh.md`:
  **don't delete.** Update the status line at the top to reflect what shipped; list only the still-open items.
  If unsure whether something shipped, leave it and flag it in the PR.
- **Accept:** `grep -rn "revision-1\|docs/archive\|production-backed-preview" .` returns no stale links.

### D5. Replace the custom test runner
- Change `package.json` `test` to `node --test --test-concurrency=2 test/*.test.js`; keep `pretest`. Delete
  `test/run-suite.js`. Check it doesn't pick up non-test helper files in `test/helpers/`.
- **Accept:** same discovered test files and aggregate outcomes before/after, subprocess/file isolation retained, failure exit status verified using a disposable failing test. Do not flatten test files into one shared-process import.

---

## H — Hygiene

### H1. Packaging
- Add `vendor/pi-sync/dist/` to `.gitignore` and `.dockerignore`.
- Dockerfile: replace `npm install --package-lock=false` with `npm ci` where a lockfile exists. Keep the
  existing pinned mise/yadm steps untouched.
- `package.json`: remove the `main` field (no `index.js`).
- Remove `playwright` from devDependencies **only if** the team agrees ad-hoc browser checks aren't needed;
  otherwise add an `npm run` script that documents its use. Ask before choosing.
- **Accept:** `docker build .` succeeds locally; `npm test` green; `packaging.test.js` updated if it regex-matches the
  old install line.

### H2. Fix `scripts/verify-real.js`
- It expects chat cwd `== $PI_WEB_HOME/chats`; chats now get per-chat subfolders (see `routes.js` new-chat handler).
  Compare the cwd after restart with the exact recorded per-chat cwd; a generic descendant-directory check is insufficient.
- **Accept:** reasoning in PR; script runs in mock-equivalent setup if possible.

---

## R — Refactors (start after C1–C4 merge; pure moves, no behavior change)

General requirements for every R ticket:
- Diff should be mostly moved lines. Reviewers will check with `git diff --color-moved=zebra`.
- No renames of exported functions, routes, CSS classes, or events.
- Each PR stays under ~800 changed lines; split further if larger.

### R1. Split `server/routes.js` by resource
- `buildApi` is one ~1,370-line closure with 58 routes. Create `server/routes/` with one module per resource group
  (e.g. `state.js`, `sessions.js`, `chats.js`, `projects.js`, `workspaces.js`, `settings.js`, `providers.js`,
  `github.js`, `sync.js`, `files.js`). Each exports `register(api, deps)`.
- `deps` is one plain object built in `buildApi` holding what handlers share (`sup`, `sync`, `hub`, `github`,
  helpers like `err`, `operationRequestId`, mutation/admission helpers). No classes, no DI framework.
- Do it in 2–3 PRs (move a few groups per PR).
- **Accept:** `npm test` green; route list identical — add a test that snapshots `METHOD path` for all registered
  routes and run it before the first PR.

### R2. Split `public/js/panels.js` by component
- Move each custom element to its own file: `settings.js`, `files.js`, `session-picker.js`, `repo-picker.js`,
  `dialogs.js` (confirm, logs, extension-UI), `app.js` (`PiApp`). Keep `customElements.define` next to each class.
  Update imports in `main.js`. No build step exists — use relative ESM imports and check the service worker's
  precache list (`public/sw.js` or equivalent) includes new files.
- **Accept:** `npm test` green; app loads in mock with no console errors; offline/PWA test still passes.

### R3. Split `applyEvent` in `public/js/api.js`
- 216-line switch. Extract handlers by family (transcript/streaming, session lifecycle, sync, git) into named
  functions in the same file. Keep the event ordering and the trailing `notify` exactly as-is.
- **Accept:** `npm test` green.

### R4. Extract event translation from `server/supervisor/real.js`
- Inspect `_onEvent` effects first. Extract only genuinely pure translation into `server/supervisor/events.js`; keep ordered effects, maps, locks, and live sessions owned by the class. Do not redesign stateful behavior to meet a file-size target.
- **Accept:** `npm test` green (`real-supervisor.test.js` especially).

### R5. CSS consolidation (needs design eye; last)
- `public/app.css` has ~175 rules that redefine earlier ones and a global `*:not(button) { border: 0 !important }`
  reset followed by ~32 `!important` restorations. Fold the late "polish" overrides into the original rule blocks
  and remove the reset + restorations.
- Work section by section (sidebar, header, thread, composer, settings), one PR each.
- **Accept:** screenshots per rule 6 for every section touched, side by side, with no visible differences
  (or differences called out and approved).

---

## A — Additional approved tickets

### A1. Async Git on request paths
- Replace synchronous Git reads used by `/api/state` with asynchronous subprocesses, starting with project/worktree snapshots. Preserve response shape and unavailable-context reporting.
- Do not convert mutation guards to async without preserving their existing serialization/admission boundary. Never add a global TTL cache to hide latency.
- Read path: extract shared pure porcelain-v2 and worktree-list parsers from `workspaces.js`; add asynchronous read counterparts using Node `execFile`/`promisify`. `projectState` awaits branches/current/default/context/remote facts without invoking the synchronous fallback in `/state` error handling. Keep snapshot-scoped reads; do not introduce a permanent cache.
- Mutation path: establish one repository-path admission boundary before adding awaits to Git mutation helpers. Cover branch creation/switch/delete, pull/push/merge, and relevant context creation; retain session/sync admission inside that boundary. Reject overlapping repository mutations rather than creating an unbounded queue. Release in `finally`, including failures.
- Split into read parsers/helpers, snapshot propagation, repository admission, then remaining request-path Git calls. Parent reviews the async call graph before integration.
- **Accept:** regression test proves a slow Git read does not block another request; snapshot semantics unchanged; concurrent conflicting mutations remain rejected/serialized. No floating promises or missing awaits.

### A2. Retire legacy merge endpoint
- User approved removing `/sessions/:id/merge` and its legacy lifecycle implementation. Keep `/merge-local`, its clean-checkout checks, and all live UI paths.
- **Accept:** old endpoint returns 404; `/merge-local` regression tests remain green; update docs and route inventory deliberately.

### A3. Remove v1 status fallback
- After C1, remove only `legacyContextStatus` and helpers used exclusively by that fallback. A failed v2 snapshot must report unavailable/unknown, never clean.
- Retain fail-closed mutation dirty checks and the porcelain parser used by stash/patch workflows.
- **Accept:** injected Git failures produce unavailable contexts and block destructive operations; normal status response unchanged.

### A4. Gate image publication on tests
- Add a credential-free `npm ci` / `npm test` job to the app image workflow, and make publication depend on it. Use the supported Node version and existing vendored-sync build.
- Keep branch triggers, image tags, digest outputs, registry permissions, and deployment behavior unchanged.
- **Accept:** workflow dependency and install commands checked; local suite passes. Remote CI execution is separate evidence, not assumed.

## Definition of done (whole plan)

- All C tickets merged with regression tests.
- Route and component registration facades stay small; large cohesive modules are not split solely to satisfy a line quota.
- All approved A tickets implemented and reviewed; plan records actual validation and remaining limitations.
- `npm test` green on the feature branch after integration. Preview/production deployment and merge to `main` require a separate instruction.
