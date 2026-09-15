# Configuration

pi-ez-web is a single-tenant application. Its configuration is a JSON object
at `$PI_WEB_HOME/config.json`; `config.example.json` is a working container
example with no credentials. The file is optional: a missing file means the
built-in defaults are used.

To install the example into the Compose volume without replacing an existing
configuration, stop the service and use a one-shot container. The exclusive
creation check leaves an existing file untouched:

```sh
set -e
docker compose stop
docker compose run --rm --no-deps -T --entrypoint /bin/sh pi-ez-web -c '
  set -e
  umask 077
  mkdir -p "$PI_WEB_HOME"
  if [ -e "$PI_WEB_HOME/config.json" ] || [ -L "$PI_WEB_HOME/config.json" ]; then
    printf "%s\n" "config.json already exists" >&2
    exit 1
  fi
  set -C
  cat > "$PI_WEB_HOME/config.json"
  chmod 600 "$PI_WEB_HOME/config.json"
' < config.example.json
docker compose up -d
```

## Configuration object

The supported top-level fields are:

- `projects`: configured repositories. Each entry has `id`, `name`, and
  `repoPath`, and may have `hooks`, `setup`, and an `environment` mapping.
- `projectHooks`: deployment-wide hook commands.
- `projectHookSets`: hook defaults keyed by project name.
- `worktreeRoot`: root for worktrees created by the application. Use a stable,
  persistent absolute path; Git worktree metadata records absolute paths. With
  the Compose defaults and no config file, this is
  `/data/pi-ez-operator-home/.pi/worktrees`; the example config uses
  `/data/pi-ez-worktrees`.
- `reposRoot`: default root for repository discovery and clones.
- `port`: server port when `PORT` is not set.
- `defaultModel`: `null` for automatic model selection or a usable
  `provider/modelId`.
- `defaultThinkingLevel`: one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, or `max`.
- `pi`: optional explicit Pi profile, package, and extension settings.
- `repositorySources`: `default` (`local`, `github`, or `git-url`) and optional
  GitHub `clientId` and `owner`.
- `sync`: optional `serverUrl` and `allConversations` setting.

A project environment contains names only:

```json
{
  "id": "my-project",
  "name": "my-project",
  "repoPath": "/data/repos/my-project",
  "environment": {
    "PROJECT_API_TOKEN": "DEPLOYMENT_PROJECT_API_TOKEN"
  }
}
```

At command spawn, the server reads `DEPLOYMENT_PROJECT_API_TOKEN` from its
current environment and supplies its value as `PROJECT_API_TOKEN`. Names are
validated, resolved afresh for each command, and never replaced by resolved
values in `config.json` or API state. A source must exist; an intentionally
empty source is valid. A missing source fails before the command starts with
`project_environment_source_missing`.

This mapping is convenience configuration, not a security boundary. The
server, configured hooks, and trusted Pi commands run as the same service user.
A trusted command can read the inherited deployment environment or edit the
configuration, so mappings do not isolate projects or act as access controls.

## Environment precedence

The built-in defaults are an empty project list, automatic model selection,
medium thinking, local repository sources, disabled synchronization, and no Pi
profile. Effective values use deployment environment first where an override
exists, then `config.json`, then the built-in default:

- `PORT` overrides `port`, then `3141` is used.
- `PI_WEB_REPOS_ROOT` overrides `reposRoot`, then `$HOME/src` is used.
- `worktreeRoot` has no environment override; it falls back to
  `$HOME/.pi/worktrees`.
- `PI_SYNC_SERVER_URL` and `PI_WEB_SYNC_ALL_CONVERSATIONS` override their
  `sync` fields.
- `PI_WEB_GITHUB_CLIENT_ID` and `PI_WEB_GITHUB_OWNER` override their GitHub
  config fields. `PI_WEB_GITHUB_TOKEN` takes precedence over the stored GitHub
  auth file.

The Compose `.env` file controls Compose interpolation only. It does not pass
arbitrary variables into the container. Add deployment variables explicitly to
the service's `environment` section or use a private, untracked Compose
`env_file`. For example, keep this as an untracked `compose.private.yaml`:

```yaml
services:
  pi-ez-web:
    environment:
      DEPLOYMENT_PROJECT_API_TOKEN: ${DEPLOYMENT_PROJECT_API_TOKEN:?set DEPLOYMENT_PROJECT_API_TOKEN}
      PI_WEB_GITHUB_CLIENT_ID: ${PI_WEB_GITHUB_CLIENT_ID:?set PI_WEB_GITHUB_CLIENT_ID}
```

Then add the names-only mapping shown above and run with values supplied by
the shell or an untracked `.env.private` file:

```sh
docker compose --env-file .env.private -f compose.yaml -f compose.private.yaml up -d
```

The client ID is public configuration; no GitHub client secret is needed.

The deployment-facing environment variables are:

| Variable | Effect |
| --- | --- |
| `PI_WEB_HOME` | Application state root; overrides the default `~/.pi-web-ui`. |
| `PI_CODING_AGENT_DIR` | Pi settings, auth, packages, and transcripts root. |
| `PI_WEB_REPOS_ROOT` | Repository discovery and clone root; overrides `reposRoot`. |
| `PORT` | Listening port; overrides `config.json` `port`. |
| `PI_WEB_MODE` | `real` by default; `mock` is for local testing. |
| `PI_WEB_REPOSITORY_SOURCE` | Read-only default repository source. |
| `PI_WEB_GITHUB_CLIENT_ID` | Public GitHub OAuth App client ID; overrides config. |
| `PI_WEB_GITHUB_OWNER` | Optional GitHub user or organization filter; overrides config. |
| `PI_WEB_GITHUB_TOKEN` | Explicit GitHub credential; takes precedence over stored app auth. |
| `PI_SYNC_SERVER_URL` | Sync endpoint; overrides `sync.serverUrl`. |
| `PI_WEB_SYNC_ALL_CONVERSATIONS` | Boolean override for `sync.allConversations`. |
| `PI_WEB_SYNC_CLIENT_MODULE` | Optional explicit pi-sync client module path. |
| `PI_WEB_PRESTART_COMMAND` | Trusted synchronous shell command run before startup. |
| `PI_WEB_PRESTART_TIMEOUT_MS` | Positive timeout for the prestart command; 120 seconds by default. |
| `PI_WEB_UI_ONLY` | Serves the static UI and UI health/config routes without the stateful API. |

Environment-backed settings are read-only in Settings. The server never
mutates its own `process.env` when resolving project mappings.

## Provider setup

The browser Settings panel can start provider login when Pi has no usable model.
Provider credentials are stored by Pi below `$PI_CODING_AGENT_DIR`; keep that
path persistent. `defaultModel: null` selects the first currently available
model, while an explicit value must be a usable `provider/modelId`. GitHub
device login additionally needs a public OAuth App client ID in
`PI_WEB_GITHUB_CLIENT_ID` or `repositorySources.github.clientId`; the device
flow does not require a client secret.

## Profiles, packages, and hooks

Pi profile selection is explicit. A `null` `profile` uses deployment-local Pi
settings; a local path, local settings file, or trusted HTTPS settings URL can
be selected explicitly. `profileSource` can be `auto`, `explicit`, or
`disabled`; no GitHub-owner-to-dotfiles profile is inferred. Remote profiles,
Pi packages, extensions, and project hooks execute as the service user and
must be treated as trusted code.

Package installation uses `npm` resolved from `PATH` and may need network
access and native build tools. Project setup hooks run in the selected
workspace when a new checkout/worktree requires setup and can be rerun
manually. Hook commands use the existing allowlisted environment, have a
120-second timeout and 1 MiB captured-output limit, and are cancelled with
their process group when the request ends. Project mappings are applied at
execution time before the child-specific Git credential configuration.

## GitHub and Git credentials

GitHub device login stores app auth in `$PI_WEB_HOME/github-auth.json`.
`PI_WEB_GITHUB_TOKEN` is an externally managed alternative and takes
precedence; changing it is a deployment operation, not a Settings logout.
Pi provider credentials remain in `$PI_CODING_AGENT_DIR/auth.json`.

Repository sources are local paths, GitHub repositories, and credential-free
HTTPS Git URLs. GitHub Git operations use a child-scoped credential helper and
never put credentials in URLs or arguments. Treat both auth files and their
backups as secrets.

## Prestart command

`PI_WEB_PRESTART_COMMAND` is an optional trusted `/bin/sh -c` command run
synchronously before config loading, supervisor creation, and listening. Its
stdin is closed; it inherits the deployment process environment and uses a
120-second timeout by default. Set `PI_WEB_PRESTART_TIMEOUT_MS` to a positive
integer to change the bound. A blank command is ignored; a timeout or nonzero
exit prevents startup. Keep it idempotent, noninteractive, and free of secret
output.

## Synchronization

The optional vendored `pi-sync` integration hands off canonical chat session
JSONL and conversation metadata between Pi clients. It does not synchronize
working trees, commits, patches, worktrees, stash state, or credentials.

Set `PI_SYNC_SERVER_URL` in the service environment when enabling sync. The
extension reads its endpoint from `PI_SYNC_SERVER_URL` or `PI_SYNC_URL`; do not
rely on a config-only `sync.serverUrl` value for extension attachment. Keep
`allConversations` disabled unless every conversation should be eligible for
sync.

## Direct Node startup

The direct `npm start` launcher sets a port but does not provide the Compose
loopback port binding. Treat it as reachable on the host's network interfaces
and use a host firewall or a trusted reverse proxy when running it outside a
private workstation.

## Invalid configuration

`config.json` must contain valid JSON with an object root. A missing file uses
defaults without creating a file. An unreadable file fails with the stable
`config_unreadable` error; malformed JSON, `null`, arrays, and scalar roots
fail with `invalid_config`. Startup stops before the server listens, and the
existing file is not rewritten. Fix the file or restore a known-good backup;
do not put credentials into the example or source repository.
