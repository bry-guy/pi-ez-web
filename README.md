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

Run the mock UI without Pi credentials:

```sh
npm install
npm run dev
# open http://localhost:3141
```

Run against Pi:

```sh
npm install @earendil-works/pi-coding-agent
npm start
```

## Install and configure

Requires Node.js 20 or newer. Configure Pi once so `~/.pi/agent` contains its auth and model settings. Add projects in `~/.pi-web-ui/config.json`:

```json
{
  "projects": [
    { "id": "my-project", "name": "my-project", "repoPath": "/path/to/my-project" }
  ],
  "defaultModel": "provider/modelId"
}
```

Use `PORT` to change the HTTP port and `PI_WEB_HOME` to change the application state directory. Pi owns session transcripts; pi-ez-web stores only its small configuration and workspace bindings. The model picker is backed by Pi's available model runtime; `defaultModel` may be set to a `provider/modelId` reference.

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
