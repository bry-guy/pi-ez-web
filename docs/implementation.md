# pi-web-ui

Self-hostable web UI for [pi](https://github.com/earendil-works/pi) coding-agent
sessions. One Node process: pi SDK in-process, REST + SSE out, zero-build web
components in front. Projects map to git repos; workspaces map to concrete
checkouts; sessions are Pi conversations running inside workspaces.

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
  index.js            entry: Hono app and static UI
  routes.js           REST + SSE + slash commands + bang execution
  commands.js         Pi-native slash-command discovery and parsing
  workspaces.js       live checkout/worktree discovery and Git status
  domain.js           /api/state assembly (projects, contexts, session trees)
  events.js           SSE hub (event contract v1 + sequence snapshots)
  lifecycle.js        archival close plus legacy lifecycle compatibility
  supervisor/         real.js (pi SDK) · mock.js (scripted) — same interface
  auth-flows.js       server-side Pi OAuth/API-key interaction bridge
  github.js           GitHub device login, public/private API listing, and token store
  hooks.js             configurable project hook resolution and execution
  git-credential-helper.js  host-restricted GitHub credential helper
  version.js           REST API contract/capability marker
  repositories.js     validated HTTPS cloning with temporary GIT_ASKPASS
public/               index.html + app.css + ES modules; no build step
                         marked + DOMPurify are served locally for safe GFM replies
test/                 workspaces (real git) · server integration (mock+SSE) · SDK/auth/clone surfaces · DOM gate
scripts/verify-real.js  credentialed end-to-end smoke
docs/archive/CHECKLIST.md  archived real-browser click-through gate
```

Pi-web state lives in `~/.pi-web-ui/` (`config.json`, `bindings.json`,
`closed.json`, `github-auth.json`, and `chats/`). Existing project worktrees
are discovered wherever Git records them; `worktreeRoot` is used for
app-created non-main worktrees.
Pi owns transcripts, settings, models, and AI auth under
`PI_CODING_AGENT_DIR` (normally `~/.pi/agent`). The optional `config.json` `pi`
block can layer a local or HTTPS `settings.json` profile over SDK sessions and
add package/extension sources. Pi's resource loader installs missing npm/git
packages in the persistent agent directory. Remote profiles are cached after a
successful fetch; they never replace deployment-local credentials or session
storage. The web supervisor binds extensions in headless JSON mode so tools,
commands, hooks, `session_start`, and dynamic resources work, while TUI/RPC
extension dialogs remain unavailable. Pi's built-in slash commands are
translated into web actions (model selection, compaction, export/download,
copy, session stats, reload, navigation, and conversation start/fork) instead of being sent
to the model; terminal-only actions get a safe browser equivalent. Durable todo and background-agent lifecycle/progress activity is projected into
bounded, grouped `activity` transcript/SSE records; the headless subagent
bridge keeps live state in the supervisor and arbitrary extension widgets and
renderer functions are not exposed to the browser. New project sessions are
created in a selected discovered Git context, and forks copy conversation
history without copying or mutating Git state. New plain chats use private
scratch directories under `chats/`; legacy sessions at the shared `chats/` cwd
remain discoverable. Scratch directories are retained when a chat is closed and
may be pruned manually. Override the app home with `PI_WEB_HOME`.

The app supports Local, GitHub, and public HTTPS Git URL repository sources. Projects can inherit deployment-wide `projectHooks` and override them with a per-project `hooks` object; configured hooks run in the selected project checkout/worktree and expose their result through Workspace settings.
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
raw model HTML is not rendered. The composer discovers Pi slash commands and passes them to the web adapter,
with `/settings`, `/name`, and same-branch `/fork` handled as first-class web
actions. Transcript SSE remains contract version 1; REST state is contract
version 5 and includes capability markers for workspace and branch features.

## Invariants

- A project is a configured repository. Its detected primary branch (normally
  `main`, or `master` when that is the repository's important branch) uses the
  repository checkout; app-created non-primary branches use linked worktrees.
  Existing externally-created contexts are discovered and remain usable.
- A session has one execution directory at a time. Switching moves only that
  session; the session-picker Fork action creates a child conversation in the
  selected branch. Pi's `/fork` command creates a child on the current branch.
  Multiple sessions may share a context and the UI shows them without occupancy
  locks.
- New branches are created from a selected committed local base, defaulting to
  the detected primary branch. Creating from it fetches and fast-forwards the
  local primary branch when possible.
- Merge to the primary branch is local, confirmed, and requires a clean source
  plus a clean, up-to-date primary checkout. It never pushes or deletes
  automatically. Push is a separate explicit, non-force operation.
- Delete is a separate confirmed local branch/worktree operation. Affected
  sessions move to the primary branch, or active/affected sessions may be
  closed from the confirmation dialog. Ordinary session close archives one
  conversation only.
- Branch, checkout/worktree kind, clean/dirty state, ahead/behind, and sharing
  sessions are observed live. The file tree always displays working-tree impact
  relative to `HEAD`; an explicit diff target controls file comparison separately.
  Added subtrees are green, deleted subtrees red, and mixed/modified paths orange.

## Verification

```sh
npm test               # no credentials: git, mock HTTP+SSE, SDK, and DOM gates
npm run test:dom       # DOM interaction gate alone
npm run verify:real    # with ~/.pi/agent: real turn, model, worktree, and edit gate
```

The DOM suite is a jsdom floor; use a real browser for visual and interaction
validation because jsdom does not paint pixels. The real server has no auth or
sandbox and must remain inside a trusted LAN/tailnet/VPN.

`GET /api/sessions/:id/commands` and `POST /api/sessions/:id/command` expose
Pi's command surface to the web composer. `/settings` changes the web view and
`/name <name>` updates Pi session metadata; other discovered commands pass
through Pi's SDK command handling. Project state includes discovered Git
contexts, their live branch/status metadata, and every session using each
context. The context picker exposes branch names while keeping paths in
technical details only. The picker owns explicit branch creation, switching,
local merge, push, and deletion actions.

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
