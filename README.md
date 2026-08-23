# pi-ez-web

A self-hostable web UI for [Pi](https://github.com/earendil-works/pi) coding-agent sessions: chat with Pi in the browser, attach projects, and choose Git branches for conversations.

## Example

The current design prototype shows a project session inspecting a repository, running a command, and applying a diff.

**Desktop**

![pi-ez-web desktop design](design/screenshots/pi-ez-web-desktop.png)

**Mobile**

![pi-ez-web mobile design](design/screenshots/pi-ez-web-mobile.png)

These previews come from [design revision 2](design/revision-2/design/pi-app-standalone.html).

## Use

Run the mock UI without Pi credentials — **`npm run dev` is a scripted mock**: replies are canned (prefixed `mock:`), the model picker shows `Mock Fast` / `Mock Smart`, and nothing reaches a real agent. It exists to exercise the UI and event contract only:

```sh
npm install
npm run dev
# open http://localhost:3141
```

Run against the real Pi agent:

```sh
# npm install already includes the Pi SDK runtime dependency.
npm run verify:real   # explicit, credentialed SDK + model smoke test
npm start
```

Chats and project sessions can be created before a provider is configured. The
first prompt asks you to connect a model provider when no usable model is
available. Assistant replies render GitHub-flavored Markdown (headings, lists,
tables, links, quotes, and code blocks); model-supplied HTML is removed and the
rendered output is sanitized. The composer discovers Pi extension, prompt-template,
and skill commands. Pi's built-in slash commands are web-adapted too: model selection, compaction, export/download, copy, session stats, reload, navigation, and provider settings work from the same `/` palette.
Settings provides Anthropic OAuth/API-key login, OpenAI ChatGPT/Codex OAuth,
OpenAI API-key login, and the default-model selector. Project sessions provide a
small branch workflow: choose a branch and name when starting, then use the
session title to Switch or Fork into another branch. The same view offers local
Merge to main, Push, and confirmed local branch deletion. Branch state,
checkout/worktree kind, clean/dirty state, and sessions sharing a context remain
visible. `/fork` remains Pi's built-in same-branch conversation fork. Plain chats
intentionally have none of the project branch controls.

## Install and configure

Requires Node.js 20 or newer. Configure Pi once so `~/.pi/agent` contains its auth and model settings. Add projects in `~/.pi-web-ui/config.json`:

```json
{
  "projectHooks": {
    "setup": "mise install && mise run bootstrap",
    "check": "mise run check"
  },
  "projects": [
    { "id": "my-project", "name": "my-project", "repoPath": "/path/to/my-project" }
  ],
  "reposRoot": "~/src",
  "defaultModel": null,
  "sync": {
    "serverUrl": null,
    "allConversations": false
  },
  "pi": {
    "profile": "https://github.com/bry-guy/dotfiles",
    "packages": [],
    "extensions": []
  },
  "repositorySources": {
    "default": "local",
    "github": { "owner": "bry-guy" }
  }
}
```

`defaultModel: null` means Automatic: use the first currently available
provider model. An explicit value must be a usable `provider/modelId` reference.

The optional `pi` block is the simplest way to share Pi behavior with the web
runtime. `profile` accepts a local Pi profile directory, a local `settings.json`,
or a credential-free HTTPS URL. When `profile` is automatic and a GitHub
owner/account is configured, pi-ez-web uses that account's `dotfiles` repository;
an explicit profile URL or path overrides this behavior. A GitHub repository URL
reads `.pi/agent/settings.json` from the repository's resolved default branch,
including `main` and `master`; a GitHub blob URL can select another file, for
example `.pi/profiles/rpiv/settings.json`. The profile's declarative settings are
layered onto each web session, while `packages` and `extensions` add sources
directly.
Relative paths in the web config resolve from `PI_WEB_HOME`. Missing npm/git
packages are installed by Pi into the persistent `PI_CODING_AGENT_DIR` when a
session loads. GitHub profiles also fetch complete skill directories and
supported extension resources into a deployment-local commit snapshot;
**Settings → Refresh profile** re-fetches them. The last successfully fetched
remote profile and resources are cached for restart/offline fallback.

Profiles intentionally do **not** import `auth.json`, models, or transcripts:
those remain deployment-local in `PI_CODING_AGENT_DIR`. Remote Pi packages and
extensions execute as the server user with full system access, so an automatic
GitHub dotfiles profile is also a trust decision: reference only accounts and
repositories you trust. Refresh reloads the selected idle session runtime;
active streaming sessions are deferred safely. Headless-compatible tools,
commands, hooks, startup events, skills, and prompts work in pi-ez-web;
terminal-only extension UI is not rendered
and extensions see `ctx.hasUI === false`. Durable todo state and
background-agent lifecycle/progress snapshots are shown as grouped, persistent
safe activity cards below the chat; parallel
agents remain visible until they finish, while arbitrary extension widgets are
not rendered. The same fields are viewable and editable
under **Settings → Pi profile & extensions**.

Use `PORT` to change the HTTP port and `PI_WEB_HOME` to change application
state. `PI_WEB_REPOS_ROOT` overrides the repository scan and clone root (for
example, `PI_WEB_REPOS_ROOT=/Users/bryan/dev mise start`). The project picker
supports Local, GitHub, and public HTTPS Git URL sources. With a configured
owner, public GitHub repositories can be browsed and cloned before login;
GitHub device login adds private repositories and stores its token in
`PI_WEB_HOME/github-auth.json`; Pi AI credentials remain in
`PI_CODING_AGENT_DIR/auth.json`. Never put either credential in `config.json`.

Other environment overrides are `PI_WEB_REPOSITORY_SOURCE`,
`PI_WEB_GITHUB_CLIENT_ID` (advanced server OAuth-app override),
`PI_WEB_GITHUB_OWNER`, `PI_WEB_GITHUB_TOKEN`, `PI_WEB_SYNC_SERVER_URL`, and
`PI_WEB_SYNC_ALL_CONVERSATIONS`. Sync environment values are read-only in
Settings; without a sync server URL, conversations remain local-only. The
client ID is not a normal user setting: until the project ships its own
registered OAuth App ID, a deployment must provide that public ID through this
advanced override.
Environment values take precedence over config and are read-only in Settings.

The production image builds the pinned `pi-sync` client from the stamped
source snapshot under `vendor/pi-sync`; `vendor/pi-sync/UPSTREAM_COMMIT` must
match the `PI_SYNC_COMMIT` Docker build argument. For a local checkout, build
the sibling package and point the adapter at it without adding package state to
`PI_WEB_HOME`:

```sh
npm install --package-lock=false --prefix /path/to/pi-sync/packages/pi-sync
npm run build --prefix /path/to/pi-sync/packages/pi-sync
PI_WEB_SYNC_CLIENT_MODULE=/path/to/pi-sync/packages/pi-sync mise start
```

The web adapter keeps lease tokens and ETags in memory only. It materializes a
canonical snapshot before a synchronized mutation, renews the lease while Pi
runs, uploads the settled native JSONL through the shared adapter, and releases
it. Unenrolled sessions remain local-only unless `allConversations` is enabled.

For a local real-server test, `mise start` is the normal command but does not
inherit a deployment's environment. Supply the public OAuth App client ID to
make GitHub Device Flow available locally:

```sh
PI_WEB_GITHUB_CLIENT_ID='<your public OAuth App client ID>' mise start
```

No client secret is needed. Alternatively, keep the public ID only in your
machine-local `~/.pi-web-ui/config.json` under
`repositorySources.github.clientId`. The Settings **Sign in with GitHub** action
opens the Device Flow directly; approve its displayed code in GitHub while
leaving the repository dialog open.

The default local repository root is `$HOME/src`. The picker also accepts an
absolute or `~/...` repository path directly. Existing Git worktrees are
discovered in place. The repository's primary branch (detected from
`origin/HEAD`, the current `main`/`master` branch, or the available local
branches) uses the repository checkout; app-created non-primary branches use
worktrees. Creating a branch from the primary branch fetches and fast-forwards
it when possible; merging locally into it performs the same freshness and
cleanliness checks. Push is explicit and never forced.
Project hooks are inherited from `projectHooks` and may be overridden per
project with a `hooks` object, for example
`"hooks": { "setup": "./script/install", "check": "./script/check" }`.
Configured hooks remain explicit commands and may change the selected context.
Pi-web's config, bindings, chats, and UI state remain under `~/.pi-web-ui`;
bindings preserve a session's execution context and are not branch state. Plain
chats use private scratch workspaces under
`~/.pi-web-ui/chats/<scratch-id>` and scratch directories are retained for
manual cleanup. The model picker is backed by Pi's available model runtime.

### iOS / PWA

The app includes a standalone web-app manifest, iOS icon metadata, a versioned
app-shell service worker, safe-area spacing, and reconnect handling for apps
that are suspended and resumed by iOS. Serve it over HTTPS, open the URL in
Safari, then choose **Share → Add to Home Screen**. Launching the new Home
Screen icon opens pi-ez-web as a standalone app.

The service worker caches only the static app shell. API requests, transcripts,
SSE, provider authentication, and GitHub flows are never cached. If the device
loses connectivity, the app shows an offline state and catches up from the
server after it returns online or comes back to the foreground; agent turns
continue on the server. A new shell build displays an update prompt before
reloading.

## Trust boundary

v1 has no authentication and no sandbox: the agent can run shell commands as the service user. Bind it only inside a trusted LAN or tailnet/VPN. Never port-forward it or expose it directly to the public internet.

## Mise tasks

[`mise.toml`](mise.toml) requires Node 22 and wraps the common local commands:

```sh
mise install       # install the declared Node version
mise bootstrap     # install npm dependencies
mise dev           # mock server; isolated state under .mise/state/mock
mise test          # run server, SDK, and DOM tests
mise test:dom      # run the DOM-only gate
mise check         # tests plus whitespace validation
mise start         # real server
mise kill          # stop listeners on PORT (default 3141)
mise verify-real   # credentialed real-Pi smoke test
mise reset         # clear mock state
```

With the mock server running, `mise dev-project` registers the current checkout as a project. `mise preview-design` opens the latest standalone prototype on macOS. Set `PI_WEB_HOME` or `PORT` to override the defaults. `mise kill` also accepts a port directly (`mise kill -- 3141`).

See the [runtime environment roadmap](docs/roadmap.md), [deployment.md](docs/deployment.md), [implementation.md](docs/implementation.md), [archived PLAN.md](docs/archive/PLAN.md), [archived remediation plan](docs/archive/pi-web-ui-remediation.md), and [design/](design/) for the implementation and design references. Use the archived [CHECKLIST.md](docs/archive/CHECKLIST.md) for the browser click-through gate.

The private-GHCR GitOps deployment is defined in [`deploy/k8s/`](deploy/k8s/) and bootstrapped through [`deploy/argocd/`](deploy/argocd/). Site-specific operator credentials and k3s tasks are documented in the infra repository's `selfhost/platform/pi-ez-web/README.md`.
