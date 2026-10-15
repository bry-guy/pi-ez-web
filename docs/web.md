# web

The site you open: chats, the sidebar, settings, model and GitHub sign-in. It is `node server/index.js` from the pi-ez-web image (the image's default command), listening on port 3141.

Without workspaced, web runs projects itself in its own process. That is the one-container quick start. With `PI_WEB_WORKSPACED_URL` set, every project lives in a worker, and web only proxies to it.

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_HOME` | `~/.pi-web-ui` | App state: `config.json`, chat bindings, the GitHub login, the snapshot cache of worker projects |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's directory: model logins (`auth.json`) and sessions |
| `HOME`, `XDG_*_HOME` | | Keep on the persistent volume so tools and caches survive restarts |
| `PI_WEB_WORKSPACED_URL` | unset | Base URL of workspaced. Setting it moves projects to workers |
| `WORKSPACED_TOKEN` | unset | Bearer token for workspaced. Must match workspaced's token |
| `PI_WEB_GITHUB_CLIENT_ID` / `PI_WEB_GITHUB_TOKEN` | unset | GitHub sign-in (public OAuth client ID) or a fixed token. See [Configuration](configuration.md) |
| `PI_WEB_PRESTART_COMMAND` | unset | Shell run before start, e.g. fetching dotfiles or seeding `config.json` (120 s limit) |
| `PI_SYNC_SERVER_URL` | unset | Optional [pi-sync](https://github.com/bry-guy/pi-sync) server |

Everything else (default model, Pi profile and packages, repository source) is in **Settings** or [`config.json`](configuration.md).

## Logins reach workers

When you sign in to GitHub or a model provider, web sends the login to workspaced (`PUT /v1/github-auth`, `PUT /v1/model-auth`), and workspaced hands it to every worker read-only. Every worker can therefore read those logins. You sign in once, in web.

## Security

web has no authentication. Anyone who can reach it can run commands as its user, and through workspaced, in every worker. Put it behind an authenticating, streaming-capable reverse proxy on a private network. See [Deployment](deployment.md).
