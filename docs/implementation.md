# pi-web-ui

Self-hostable web UI for [pi](https://github.com/earendil-works/pi) coding-agent
sessions. One Node process: pi SDK in-process, REST + SSE out, zero-build web
components in front. Projects map to git repos; sessions map to branch
worktrees; fork ⑂ branches both the conversation and the code.

## Run

```sh
npm install                                  # includes the Pi SDK runtime dependency
npm start                                    # http://localhost:3141
```

No credentials handy? Full UI against a scripted agent:

```sh
npm run dev            # PI_WEB_MODE=mock
```

## Layout

```
server/
  index.js            entry: Hono app, static UI, startup worktree prune
  routes.js           REST + SSE + slash commands + bang execution
  commands.js         Pi-native slash-command discovery and parsing
  workspaces.js       git: worktree-per-branch, remote branches, occupied rules, safe fork transfer
  domain.js           /api/state assembly (projects, session trees, occupied map)
  events.js           SSE hub (event contract v1 + sequence snapshots)
  lifecycle.js        explicit close and merge lifecycle
  supervisor/         real.js (pi SDK) · mock.js (scripted) — same interface
  auth-flows.js       server-side Pi OAuth/API-key interaction bridge
  github.js           GitHub device login, public/private API listing, and token store
  version.js           REST API contract/capability marker
  repositories.js     validated HTTPS cloning with temporary GIT_ASKPASS
public/               index.html + app.css + ES modules; no build step
                         marked + DOMPurify are served locally for safe GFM replies
test/                 workspaces (real git) · server integration (mock+SSE) · SDK/auth/clone surfaces · DOM gate
scripts/verify-real.js  credentialed end-to-end smoke
docs/archive/CHECKLIST.md  archived real-browser click-through gate
```

Pi-web state lives in `~/.pi-web-ui/` (`config.json`, `bindings.json`,
`closed.json`, `github-auth.json`, and `chats/`); project worktrees default to
the Pi-adjacent `~/.pi/worktrees` (and can be overridden with `worktreeRoot`).
Pi owns transcripts, settings, models, and AI auth under
`PI_CODING_AGENT_DIR` (normally `~/.pi/agent`). New plain chats use private
scratch directories under `chats/`; legacy sessions at the shared `chats/` cwd
remain discoverable. Scratch directories are retained when a chat is closed and
may be pruned manually. Override the app home with `PI_WEB_HOME`.

The app supports Local, GitHub, and public HTTPS Git URL repository sources.
A configured GitHub owner can browse and clone public repositories without
signing in; GitHub device authorization adds private repositories and stores
its token separately from `config.json`. Private clones use a temporary
`GIT_ASKPASS` helper and never place credentials in clone URLs or process
arguments. Clone processes ignore global/system Git URL rewrite configuration
so validated public HTTPS URLs cannot turn into SSH. The
GitHub OAuth client ID is an advanced server deployment setting, not a normal
user-facing setting. AI login flows use a short-polling REST API because Pi's
provider OAuth implementations are server-side Node flows. Assistant replies
use locally served `marked` GFM parsing followed by DOMPurify sanitization;
raw model HTML is not rendered. The composer discovers Pi slash commands and
passes them to the SDK, with `/settings` and `/name` handled as first-class web
actions. Transcript SSE remains contract version 1; REST state is contract
version 2 and includes a capability marker so stale server processes produce a
restart prompt.

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

`GET /api/sessions/:id/commands` and `POST /api/sessions/:id/command` expose
Pi's command surface to the web composer. `/settings` changes the web view and
`/name <name>` updates Pi session metadata; other discovered commands pass
through Pi's SDK command handling. Branch popovers include local, worktree,
default, and fetched remote refs; selecting a remote ref creates a local
worktree branch from that ref. The branch cleanup endpoint remains API-only.

Unnamed sessions display a compact whitespace-normalized truncation of their
first message; pi-ez-web does not append a session name entry. The server sorts
project session roots by numeric activity time, including activity in a forked
child.

The repository picker scans `$HOME/src` by default. Set `reposRoot` in
`~/.pi-web-ui/config.json`, use `PI_WEB_REPOS_ROOT`, or type an absolute path
in the picker to use a different local repository directory. The environment
variable takes precedence over the config value. The picker also supports
GitHub device login/private repository cloning and public HTTPS Git URLs.
`defaultModel: null` means Automatic; an explicit default must be currently
available. Chats and project sessions can be created without a model and return
`409 model_required` on the first prompt when no provider is usable.

The design (tokens, screens, event contract) is preserved in the archived
[PLAN.md](archive/PLAN.md) and design README; the UI is a direct port of the
approved prototype.
