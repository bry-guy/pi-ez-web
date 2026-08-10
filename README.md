# pi-ez-web

A self-hostable web UI for [Pi](https://github.com/earendil-works/pi) coding-agent sessions: chat with Pi in the browser, attach projects, and work in branch-backed sessions.

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

Run against the real Pi agent (requires `~/.pi/agent` to be configured):

```sh
npm install @earendil-works/pi-coding-agent
npm run verify:real   # sanity-check SDK + credentials
npm start
```

The Settings screen shows which mode the server is running in. Branch switching, the file tree, and forking appear only inside a **project** session — connect a repo first (the `+` next to PROJECTS, or the Projects screen). Plain chats intentionally have none of those affordances.

## Install and configure

Requires Node.js 20 or newer. Configure Pi once so `~/.pi/agent` contains its auth and model settings. Add projects in `~/.pi-web-ui/config.json`:

```json
{
  "projects": [
    { "id": "my-project", "name": "my-project", "repoPath": "/path/to/my-project" }
  ],
  "reposRoot": "~/src",
  "worktreeRoot": null,
  "defaultModel": "provider/modelId"
}
```

Use `PORT` to change the HTTP port, `PI_WEB_HOME` to change the application state directory, and `PI_WEB_REPOS_ROOT` to override the repository scan root (for example, `PI_WEB_REPOS_ROOT=/Users/brain/dev mise start`). You can set the persistent `reposRoot` value in `~/.pi-web-ui/config.json` instead; the default is `$HOME/src`. The project picker also accepts an absolute or `~/...` repository path directly. Omit `worktreeRoot` to use the Pi-adjacent default `~/.pi/worktrees`, or set it to an absolute path. Project entries may set `mode` to `manual` (default) or `auto`; change that in `config.json` for now—the UI does not toggle it. Pi-web's own config, bindings, chats, and UI state remain under `~/.pi-web-ui`; existing worktrees are discovered in place and are not moved. Pi owns session transcripts. Plain chats are Pi sessions with a private scratch workspace under `~/.pi-web-ui/chats/<scratch-id>`; project sessions use repository checkouts/worktrees. Scratch directories accumulate and are safe to prune manually after checking for files you want to keep. The model picker is backed by Pi's available model runtime; `defaultModel` may be set to a `provider/modelId` reference.

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
mise verify-real   # credentialed real-Pi smoke test
mise reset         # clear mock state
```

With the mock server running, `mise dev-project` registers the current checkout as a project. `mise preview-design` opens the latest standalone prototype on macOS. Set `PI_WEB_HOME` or `PORT` to override the defaults.

See [PLAN.md](PLAN.md), [docs/plans/pi-web-ui-remediation.md](docs/plans/pi-web-ui-remediation.md), and [design/](design/) for the implementation and design references. Use [CHECKLIST.md](CHECKLIST.md) for the browser click-through gate.
