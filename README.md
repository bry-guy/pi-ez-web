# pi-ez-web

A self-hostable, single-tenant web UI for [Pi](https://github.com/earendil-works/pi)
coding-agent sessions. Chat in a browser, attach repositories, run trusted
commands, and hand off conversations between Pi clients.

## Quick start with Docker Compose

The default setup builds the image locally, keeps state in a named volume, and
publishes only on loopback:

```sh
cp .env.example .env
docker compose up --build -d
curl --fail http://127.0.0.1:3141/ui-health
```

Open <http://127.0.0.1:3141>. The first start needs no `config.json`; use
[config.example.json](config.example.json) and the instructions in
[docs/configuration.md](docs/configuration.md) when you want to predeclare
projects or hooks.

This service has no built-in authentication or sandbox. Keep it on a trusted
LAN or tailnet/VPN; never port-forward it or expose it directly to the public
internet. See [docs/deployment.md](docs/deployment.md) before using a reverse
proxy or replacing the persistent volume.

## Configuration

[docs/configuration.md](docs/configuration.md) is the authoritative reference.
The short version:

- `PI_WEB_HOME` stores app state; `PI_CODING_AGENT_DIR` stores Pi auth,
  settings, packages, and transcripts; repositories and worktrees need stable,
  writable paths.
- `project.environment` stores only destination/source variable names. Values
  are resolved at command spawn, missing sources fail closed, and mappings are
  convenience configuration rather than isolation.
- GitHub device login stores app auth in `github-auth.json`; an explicitly
  injected `PI_WEB_GITHUB_TOKEN` takes precedence. Pi provider auth remains in
  Pi's `auth.json`.
- The app-managed OnePassword lifecycle is removed. Inject any deployment
  source variables explicitly and opt projects into them with the names-only
  mapping; pi-ez-web does not import, validate, store, or delete those secrets.
- Pi profiles are explicit. A null profile uses deployment-local settings; use
  only trusted profiles, packages, extensions, and hooks.

The Compose `.env` file controls interpolation only. It does not pass arbitrary
variables to the container; add deployment variables to the service's
`environment` or a private untracked `env_file`.

## Local development

The real server requires Node.js 22.19.0 or newer. The mock server needs no
provider credentials:

```sh
npm ci
npm run dev
```

For the real server, configure Pi in `PI_CODING_AGENT_DIR` (the usual local
location is `~/.pi/agent`) and run:

```sh
npm start
```

`mise` is an optional local task runner for the repository's development
commands; it is not required by the image or runtime. The standard checks are
`mise run test` and `mise run check`.

## Synchronization

The optional vendored `pi-sync` integration hands off canonical conversation
JSONL and metadata between laptop Pi sessions and the web client. It does not
synchronize working trees, commits, patches, worktrees, stash state, or
credentials. Provide `PI_SYNC_SERVER_URL` to the service and extension when
enabling it; do not rely on a config-only sync URL for extension attachment.
