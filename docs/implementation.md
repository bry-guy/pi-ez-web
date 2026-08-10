# pi-web-ui

Self-hostable web UI for [pi](https://github.com/earendil-works/pi) coding-agent
sessions. One Node process: pi SDK in-process, REST + SSE out, zero-build web
components in front. Projects map to git repos; sessions map to branch
worktrees; fork ⑂ branches both the conversation and the code.

## Run

```sh
npm install
npm install @earendil-works/pi-coding-agent   # peer dep; needs ~/.pi/agent configured (run `pi` once)
npm start                                     # http://localhost:3141
```

No credentials handy? Full UI against a scripted agent:

```sh
npm run dev            # PI_WEB_MODE=mock
```

## Layout

```
server/
  index.js            entry: Hono app, static UI, startup worktree prune
  routes.js           REST + SSE + bang execution
  workspaces.js       git: worktree-per-branch, occupied rules, safe fork transfer
  domain.js           /api/state assembly (projects, session trees, occupied map)
  events.js           SSE hub (event contract v1 + sequence snapshots)
  lifecycle.js        explicit close and merge lifecycle
  supervisor/         real.js (pi SDK) · mock.js (scripted) — same interface
public/               index.html + app.css + ES modules; no build step
test/                 workspaces (real git) · server integration (mock+SSE) · SDK surface · DOM gate
scripts/verify-real.js  credentialed end-to-end smoke
docs/archive/CHECKLIST.md  archived real-browser click-through gate
```

Pi-web state lives in `~/.pi-web-ui/` (`config.json`, `bindings.json`,
`chats/`); project worktrees default to the Pi-adjacent `~/.pi/worktrees`
(and can be overridden with `worktreeRoot`). Pi owns transcripts and auth under
`~/.pi/agent`. New plain chats use private scratch directories under `chats/`;
legacy sessions at the shared `chats/` cwd remain discoverable. Scratch
directories are retained when a chat is closed and may be pruned manually.
Override the app home with `PI_WEB_HOME`.

## Invariants

- Workspace = worktree, one per branch (git's own constraint). The app never
  mutates your checkout — it only adds worktrees under `worktreeRoot`.
- One session per workspace by convention: moving a session onto a branch
  occupied by another session is a 409; the branch popover disables those rows.
  The app-managed one-active-turn lock serializes attached sessions; external
  Pi CLI concurrency is user-managed because the SDK exposes no reliable
  cross-process active-turn signal.
- Fork carries dirty state from app-owned worktrees: tracked modifications +
  untracked files land in the fork and survive in the parent. A dirty project
  checkout is refused (`409 checkout_dirty`) rather than stashed. Code forks at
  *present* state; the conversation forks at the chosen message.
- Lifecycle is explicit and git-only (PRs deferred). **Merge** (header button):
  `git merge --no-ff` into the checkout's branch — the one sanctioned checkout
  mutation; preflight requires worktree + checkout clean; conflicts abort
  cleanly and leave everything untouched. Success removes the worktree,
  deletes the branch, and the session continues on the default branch.
  **Close ×** (sidebar): worktree sessions are destroyed — worktree removed,
  branch force-deleted, changes lost (the confirm dialog is the guard);
  checkout sessions and chats are archived, nothing in git touched.
  Transcripts always survive; stale-session cleanup is explicit rather than
  timer-driven.

## Verification

```sh
npm test               # no credentials: git, mock HTTP+SSE, SDK, and DOM gates
npm run test:dom       # DOM interaction gate alone
npm run verify:real    # with ~/.pi/agent: real turn, model, fork, and edit gate
```

The DOM suite is a jsdom floor; use a real browser for visual and interaction
validation because jsdom does not paint pixels. The real server has no auth or
sandbox and must remain inside a trusted LAN/tailnet/VPN.

`POST /api/sessions/:id/name` is intentionally API-only in v1; the UI has no
rename control. The branch cleanup endpoint is also API-only.

The repository picker scans `$HOME/src` by default. Set `reposRoot` in
`~/.pi-web-ui/config.json`, use `PI_WEB_REPOS_ROOT`, or type an absolute path
in the picker to use a different local repository directory. The environment
variable takes precedence over the config value.

The design (tokens, screens, event contract) is preserved in the archived
[PLAN.md](archive/PLAN.md) and design README; the UI is a direct port of the
approved prototype.
