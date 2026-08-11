> Superseded — predates workspace modes and streaming locks.

# Plan: serving the Pi Web UI — final v1 design

Supersedes the initial plan. Changes from review: worktrees by default (branch-switch guard removed), fork carries dirty state, restart-survival machinery removed per requester, Fastify replaced with Hono, pi-ez concepts folded in (config file, bindings, setup hook, composable modules in a monolith).

---

## 1. Integration mode: pi SDK, in-process, one Node monolith

**SDK, single process.** The UI's hardest requirements map directly onto SDK surface: `fork(entryId)` / `navigateTree()` for ⑂, `steer()` / `followUp()` for Enter vs Alt+Enter, `subscribe()` for typed events, `setModel()` for the model chip. Pi's own docs recommend `AgentSession` directly over spawning the RPC subprocess when you're in Node — and we're in Node by necessity, not preference: **the SDK is a Node library, so any other language/runtime (Go, Rust, Bun, Deno) reintroduces RPC mode plus subprocess supervision.** Rejected alternatives:

- **RPC** — process isolation, but costs spawn/restart/reap supervision, per-session subprocess memory, and strict LF-only JSONL framing (Node `readline` corrupts it on U+2028/U+2029). The migration escape hatch, not the start.
- **Print/JSON** — process-per-turn structurally cannot implement steering (nothing live to interrupt), holds no follow-up queue, pays cold start per turn. Wrong for a persistent control plane.
- **Interactive TUI** — not a programmatic interface.

**Restart behavior:** a crash kills in-flight turns; the user refreshes and re-sends. Sessions themselves persist in Pi's JSONL as it streams, so nothing beyond the mid-flight turn is lost. The requester explicitly accepts this; the pi-web-style web/daemon split is **cut from the roadmap**, not deferred. The `supervisor` module keeps a narrow async interface anyway (attach/prompt/steer/followUp/stop/fork/setModel/subscribe/list) — good hygiene, and it makes the split trivial if daily use ever demands it.

```
┌─ browser ─┐
     │  HTTP (fetch) + one SSE stream
┌────▼────────────────────────────────┐
│ node monolith (Hono)                │
│  ├ static UI (no build step)        │
│  ├ REST + SSE routes                │
│  ├ config      ~/.pi-web-ui/*.json  │
│  ├ workspaces  git worktree ops     │
│  ├ supervisor  Map<id, AgentSession>│
│  └ events      fan-out to SSE       │
│     (pi SDK; auth/models ~/.pi/agent)
└─────────────────────────────────────┘
```

**Server framework: Hono** (tiny, TS-first, built-in SSE helper, runs on plain Node). Requirements are static files, ~10 JSON routes, one SSE endpoint; Fastify's plugin system and schema validation are unused weight, Express is legacy. Bare `node:http` is the acceptable zero-dependency alternative if that value wins. `@earendil-works/pi-coding-agent` is a production dependency with a caret range.

## 2. Client: web components, no htmx, no build step

Custom elements (`<pi-app>`, `<pi-sidebar>`, `<pi-thread>`, `<pi-message>`, `<pi-tool-call>`, `<pi-diff>`, `<pi-bang>`, `<pi-composer>`, `<pi-branch-menu>`, `<pi-file-tree>`), light DOM so the oklch design tokens cascade from one stylesheet, plain ES modules, zero client dependencies, one flat state object per the handoff README, `fetch()` for CRUD.

**htmx rejected:** the app has ~5 genuine CRUD interactions and one dominant stream-shaped surface. htmx would introduce a second rendering regime (server HTML fragments) that must share state (`sessionId`, `openTree`, search) with the client-rendered transcript — strictly more to maintain than one regime. Streamed server-rendered fragments per delta also rejected: the thinking-π/caret exclusivity and animation rotation are client state, and per-token fragment morphing buys nothing the JSONL snapshot doesn't provide cheaper.

## 3. Transport: SSE, reconnect by snapshot

One SSE stream per tab (`GET /api/events`), all sessions multiplexed, `sessionId` on every event — no stream teardown on session switch, and background sessions animate the sidebar.

**Reconnect/resume:** on opening a session or any (re)connect: subscribe → buffer incoming events client-side → `GET /api/sessions/:id/transcript` (rendered from Pi's active entry branch, with the hub snapshot `seq`) → apply snapshot → replay only buffered events newer than that seq. All records use stable entry/tool/bang identities, so repeated tokens are never deduped by text. No server ring buffer, no `Last-Event-ID`, no resync protocol. Mid-turn browser reconnects resume seamlessly; a server crash loses the turn and the user re-sends (accepted).

Upstream is plain POSTs: `message {text, mode: prompt|steer|followUp}`, `bang {cmd}`, `stop`.

## 4. Event contract v1

Envelope: `{ "v": 1, "seq": n, "sessionId": "s_x", "type": "...", ... }` — `seq` for client ordering/dedupe only.

```
user_record       { record: { id, role: "user", text } }
turn_start        { turnId }
message_start     { messageId, role: "assistant" }
text_delta        { messageId, delta }
message_end       { messageId }
tool_start        { toolId, name, argsSummary }
tool_end          { toolId, ok, output, meta, durationMs }
diff              { toolId, path, adds, dels,
                    hunks: [ { header, lines: [ { sign, text } ] } ] }
bang_start        { bangId, cmd }
bang_end          { bangId, exit, durationMs, stdout }
turn_end          { turnId, reason: done|stopped|errored, error? }
session_meta      { name?, model?, branch? }
session_created   { session }
session_forked    { session, parentSessionId, atEntryId }
workspace_busy    { workspacePath, bySessionId | null }      // turn-lock state, §6
```

- **Thinking vs streaming is derived, not signaled:** `message_start` with no text yet → thinking π; first `text_delta` → caret. Mutually exclusive by construction. `turn_end reason:stopped` on an empty assistant message → client removes it entirely (per the handoff's stop rule).
- **Diffs**: server converts recognized edit-tool results into structured hunks; unparseable results degrade to plain `tool_end` — the UI never gets a malformed diff.
- **Bang**: runs through `/bin/sh -c` in the session workspace, emits `bang_*` events, and persists a `pi-web:bang` custom entry in real mode so cold snapshots retain who-ran-what.
- `v` bumps on breaking change; unknown `v` → client shows a reload prompt. `tool_output_delta` deliberately omitted; add in a minor revision if long tools warrant it.

## 5. Config, state, persistence — pi-ez-shaped

Declarative config + minimal runtime state + live discovery; Pi owns transcripts and credentials.

```
~/.pi-web-ui/config.json     user-editable, UI writes too:
                             { projects: [{ name, repoPath, setup?, mode? }],
                               reposRoot, worktreeRoot, port, defaultModel }
~/.pi-web-ui/bindings.json   { sessionId → { branch, workspacePath } } — only
                             for sessions re-homed from their birth workspace
~/.pi-web-ui/chats/          private scratch cwds for plain chats; the legacy
                             shared cwd remains discoverable
```

Discovered live, never cached: worktrees/branches via `git worktree list --porcelain` + `git branch`; sessions via Pi's per-cwd session storage; file tree via `readdir`; dirty state via `git status --porcelain` when needed. In memory only: the supervisor map (lazy attach), SSE clients, per-workspace turn locks. Nothing in memory is authoritative.

A session's project and branch are derived from its workspace cwd. `chatId` semantics (no branch chip, no file tree, no fork) fall out of "no project owns that cwd."

## 6. Workspaces: worktrees by default

- **Workspace = worktree, one per branch.** This is git's own constraint, not just policy: `git worktree add` refuses to check out a branch already checked out elsewhere. Sessions on the same branch therefore share its worktree.
- **The app never mutates the user's checkout.** The project checkout is the workspace for whatever branch it has checked out (usually `main`); the app only ever *adds* worktrees under `worktreeRoot` (default `~/.pi/worktrees/<project>/<branch>`), lazily on branch-create, fork, or switch. The optional per-project `setup` command runs once on worktree creation (deps, build caches — the real cost of a worktree). Existing worktrees are discovered in place; changing the default does not move them.
- **Concurrency rule — one session per workspace, by convention.** A branch's worktree is *occupied* by the session bound to it. Moving or creating a session onto an occupied branch is blocked (server 409 `branch_occupied`; the branch popover renders occupied branches disabled with the occupying session named as meta). This coerces the sensible conversational mapping: session ↔ worktree. Viewing any session's history stays allowed — reading touches no files. The app-managed turn lock covers attached sessions; external Pi CLI concurrency is user-managed because the SDK exposes no reliable cross-process active-turn signal. Project `mode: auto` lazily binds an unbound checkout session on first send; `mode: manual` preserves raw cwd tracking. Mode changes are config-file edits for now.
- **Fork ⑂ carries dirty state from app-owned worktrees.** A dirty project checkout is refused with `409 checkout_dirty` because the app must not stash user checkout changes. For a worktree parent: `git stash push -u` → create fork branch + worktree from parent HEAD → apply the exact stash object in the fork → restore/drop it in the parent. Tracked modifications and untracked files carry; ignored artifacts don't (setup hook rebuilds them). Transcript forks via Pi-native entry IDs; branch name derived from the parent's. **Stated caveat:** code forks at *present* state — forking at an older message rewinds the conversation but not the tree. True point-in-time code requires per-turn working-copy snapshots (shadow-ref auto-commits, or a jj backend, which snapshots natively) — the named deferred path.
- **Branch switch on an existing session** re-homes it to that branch's workspace (recorded in `bindings.json`), allowed only while idle; the chip disables mid-turn.
- **Lifecycle — explicit merge/close, git-only (PRs deferred).** Semantics follow *workspace type*, not lineage: root sessions live in the checkout, forks and branch-created sessions live in worktrees. **Merge** (header button beside the branch chip; hidden on default-branch sessions and plain chats; accent-CTA confirm): preflight session idle + worktree clean + checkout clean, then `git merge --no-ff <branch>` **in the checkout — the one sanctioned mutation of the user's checkout**, since landing work into the default branch requires its working copy and is the user's explicit intent. Conflict → `merge --abort`, checkout restored, branch + worktree untouched, 409. Success → worktree removed, branch `-d`, session re-homed to the checkout and **continues on the default branch** (per the settled design). Named exemption: merge may co-home sessions on the checkout, bending one-session-per-workspace; the per-workspace turn lock still serializes agent runs there, and popover-switching onto an occupied branch stays blocked. **Close ×** (hover-reveal on sidebar session/chat rows; danger-CTA confirm with an orange warning when a worktree will be removed): worktree session → destructive — worktree removed and branch **force-deleted**, uncommitted and unmerged work lost, the confirmation dialog is the guard; checkout session or plain chat → archival only, nothing in git touched. Transcripts always survive ("closed" is a marker in `closed.json`; pi's JSONL is never deleted). The merge sweep remains as a bonus for CLI-side merges (merged+clean+idle → reaped; `autoCleanup: false` disables); detection against `origin/<default>` moves to the PR enhancement along with GitHub flows. Startup `git worktree prune` still reaps externally deleted worktrees.

## 7. Build order

1. **Plain chat end-to-end:** Hono server, supervisor + SDK, one scratch-cwd session; POST message → SSE deltas → `<pi-thread>` with thinking-π/caret/stop. Proves the loop, transport, and the two hardest transcript states first.
2. **Snapshot + reconnect:** transcript from JSONL, snapshot-then-buffer resume, chat list from Pi storage.
3. **Projects + workspaces:** config file, project list, worktree module, branch chip + popover (create = worktree add; switch = re-home when idle), turn lock.
4. **Fork:** stash-transfer + Pi `fork(entryId)`, sidebar session tree from fork lineage, rewound text into the composer.
5. **Tool / diff / bang blocks** per the event contract.
6. **File tree, settings, model chip.**

## 8. Verification loop

Everything runnable without pi credentials runs in CI/dev; the credentialed slice has its own script.

- **`PI_WEB_MODE=mock`** — the supervisor interface has a mock implementation emitting a scripted turn (thinking delay → text deltas → tool call → structured diff → completion) and honoring stop/steer/followUp semantics, persisting transcripts under the app home so snapshot/reconnect logic is exercised for real. `npm run dev` serves the full UI against it.
- **`npm test`** (node:test, no credentials, no browser):
  - *workspaces*: real git in a temp repo — worktree creation, occupied-branch 409s, fork stash-transfer (dirty state lands in the fork *and* survives in the parent), prune.
  - *server integration*: boots the app in mock mode on an ephemeral port; drives it over HTTP + a raw SSE reader; asserts the full event contract (turn lifecycle, deltas, tool, diff, stop-during-thinking removes the empty message, steer vs followUp, bang), transcript snapshot equivalence after reconnect, and the occupied/turn-lock rules end-to-end.
  - *SDK surface smoke*: imports `@earendil-works/pi-coding-agent` (dev-installed) and asserts the API names the real supervisor calls actually exist — catches SDK drift without needing credentials.
- **`npm run verify:real`** — on a machine with `~/.pi/agent` configured: boots in real mode, creates a plain chat, sends a trivial prompt, asserts assistant text arrives over SSE and the transcript snapshot matches; then a project-mode smoke (worktree session, one edit-producing prompt, diff event observed). This is the only step that needs credentials, and it's the one that validates the JSONL/transcript mapping against real pi.

## 9. Explicitly deferred

Auth/multi-tenancy (trusted single user on a trusted server; network exposure is the boundary) · sandboxing (pi-ez's mounts/secret-broker solved pi-chat's remote-VM problem; here the server is the trusted host) · GitHub-backed repo picker (v1 lists server paths in the same modal, account chip inert) · worktree pruning UI · per-turn code snapshots / jj backend · `tool_output_delta` · daemon split (cut, revivable behind the supervisor interface) · plugins/extensions surfacing.
