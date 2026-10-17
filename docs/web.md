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

## Chat header

The header's second line shows the project's Git context (branch · commit · clean, dirty or unknown, with ↑ahead and ↓behind) and, on the same line, the conversation's sync state as one label, `<state>: <message>`: `Synced: up to date`, `In use: <device>`, `Sync error: <reason>`, or `Sync: <status>` when it is not synchronized. Tap the label, or hover it, for the full detail. On a phone the line stays one line and ends in an ellipsis.

## Chat activity

While a turn runs, the chat shows a small dot spinner and one live line: the extension's working message (for example from pi-summarize), else the current tool (`Reading files.js…`, `Running npm test…`), else `Thinking…`. Tool calls and thinking are not shown inline. When the turn ends, a quiet row reads `Worked 42s · 6 steps ›`. Tapping it opens **Steps** in place of the chat, with a `<` back button and a `#steps=…` address, so Back returns to the chat at the same scroll position. Steps lists pi-summarize summaries, each expandable to the thinking and tool calls behind it; a turn without summaries lists its tool calls and thinking in order. Thinking is kept with the message, so it is available after a reload.

Untitled chats are named by their first prompt. A chat that was never prompted or named, and is not open, is left out of the sidebar; its file is kept.

## Settings

**Settings** lists its categories on the left (on a phone, first): Providers, Pi, Workers, Sync, Repositories, Defaults, Appearance, Diagnostics. Each category has its own address (`#settings/workers`, `#settings/pi`, …), so reloading or using Back returns to it. `<` returns to the chat, and on a phone `<` on a category returns to the list.

- **Pi**: the dotfiles profile, extra packages to load, and local extension paths (advanced), with what Pi loaded and any problems. **Save & reload** fetches the profile, installs missing packages, and reloads idle sessions. It is refused while a session is running; stop it first.
- **Workers** (needs workspaced; otherwise the page says workers are not enabled): each worker's state (asleep, starting, awake, busy), keep-awake, last use, resource requests and limits, live usage (`n/a` when workspaced reports none), and its grant: name, service account, namespace, egress, runtime class, and environment variable names (never values). **Reload** re-reads one worker's profile and extensions; **Reload all awake workers** does every awake worker and lists each result. **Restart** starts a fresh pod and reruns startup; the disk is kept. **Reset** wipes the worker's disk and needs its name typed; add the project again afterwards. A busy or asleep worker refuses restart and reset, and the page says why. The page refreshes every 5 seconds while it is visible.
- The sidebar shows each project's worker state; a small dot marks a worker kept awake. A worker that crashed shows an amber state; one that cannot run (crash loop, out of memory, unschedulable, stuck starting) shows **restart** in red, and tapping it restarts the worker. The reason is in its tooltip, and [Worker](worker.md#when-a-worker-breaks) explains recovery.

`mise run dev` (mock mode) shows three fixed sample workers, so the Workers page can be tried without a cluster.

## Logins reach workers

When you sign in to GitHub or a model provider, web sends the login to workspaced (`PUT /v1/github-auth`, `PUT /v1/model-auth`), and workspaced hands it to every worker read-only. Every worker can therefore read those logins. You sign in once, in web.

## Security

web has no authentication. Anyone who can reach it can run commands as its user, and through workspaced, in every worker. Put it behind an authenticating, streaming-capable reverse proxy on a private network. See [Deployment](deployment.md).
