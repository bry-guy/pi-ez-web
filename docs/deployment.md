# Deployment

pi-ez-web is a trusted, single-process, single-tenant service. The repository
contains a generic image and a minimal Compose entry point; deployment systems
may build the image or wrap it with their own secret and network tooling.

## Compose quick start

The checked-in Compose file builds locally, publishes only to loopback by
default, and keeps application, Pi, repository, and worktree data in one named
volume:

```sh
cp .env.example .env
docker compose up --build -d
curl --fail http://127.0.0.1:3141/ui-health
```

The first start needs no `config.json`. Add the example later, without
overwriting existing state, with the command in
[configuration.md](configuration.md). Stop the service with
`docker compose down`; do not add `--volumes` unless deleting all persistent
state is intentional.

The default service contract is:

| Item | Value |
| --- | --- |
| Image | Local build from this repository, tagged `pi-ez-web:local` |
| Container user | Image `node` user, UID/GID 1000 |
| Published port | `127.0.0.1:3141` on the host to `3141` in the container |
| Persistent volume | `pi-ez-web-data` mounted at `/data` |
| Application state | `/data/pi-ez-web` |
| Pi state and transcripts | `/data/pi-ez-agent` |
| Repositories | `/data/repos` |
| Created worktrees | `/data/pi-ez-worktrees` when using the example config; otherwise `/data/pi-ez-operator-home/.pi/worktrees` |
| Health check | `GET /ui-health` |

The port bind and image tag can be changed in `.env`. The Compose `.env` file
only interpolates the Compose file; it is not a general container environment
file. Pass credentials or project source variables through explicit service
environment entries or a private untracked `env_file`, as described in
[configuration.md](configuration.md).

## Persistence and ownership

Keep the `/data` volume across upgrades. The service writes atomically inside
`$PI_WEB_HOME`, so the parent directory and the volume must be writable by
UID/GID 1000. If replacing the named volume with host directories, create and
own them for UID/GID 1000 before starting the container. Keep repository and
worktree paths stable across restarts and hosts; Git worktree metadata stores
absolute paths.

Back up the whole volume or, at minimum, these sensitive and stateful paths:

- `$PI_WEB_HOME/config.json`, `bindings.json`, chats, cached Pi resources, and
  `github-auth.json`;
- `$PI_CODING_AGENT_DIR/auth.json`, models, and Pi session transcripts;
- repositories and created worktrees if they are not independently backed up.

Auth files, retained legacy credential files, and backups are secrets. Removing
the app-managed OnePassword feature did not revoke or delete any old file.
Never bake credentials into the image, config example, Compose file, URL,
command arguments, or logs.

For the checked-in Compose volume, stop the service before making a protected
archive and store that archive outside the repository. The volume name is
project-scoped, so discover it from the stopped service instead of assuming a
global name. This command refuses an existing archive and does not restart the
service if the backup fails:

```sh
set -eu
(
  set -eu
  backup_dir="${PI_EZ_WEB_BACKUP_DIR:-$HOME/pi-ez-web-backups}"
  umask 077
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  docker compose stop
  container="$(docker compose ps -aq pi-ez-web | sed -n '1p')"
  test -n "$container"
  data_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")"
  test -n "$data_volume"
  archive="$backup_dir/pi-ez-web-data.tar.gz"
  test ! -e "$archive"
  docker run --rm \
    --mount "type=volume,src=$data_volume,dst=/data,readonly" \
    --mount "type=bind,src=$backup_dir,dst=/backup" \
    alpine sh -c 'umask 077; set -C; tar -czf - -C /data . > /backup/pi-ez-web-data.tar.gz'
  chmod 600 "$archive"
)
docker compose up -d
```

To restore, stop the service and extract the archive into an anonymous newly
created volume, never over a live or stale volume:

```sh
set -eu
backup_dir="${PI_EZ_WEB_BACKUP_DIR:-$HOME/pi-ez-web-backups}"
archive="$backup_dir/pi-ez-web-data.tar.gz"
test -r "$archive"
docker compose down
restore_volume="$(docker volume create)"
docker run --rm \
  --mount "type=volume,src=$restore_volume,dst=/data" \
  --mount "type=bind,src=$backup_dir,dst=/backup,readonly" \
  alpine tar -xzf /backup/pi-ez-web-data.tar.gz -C /data
cat > compose.restore.yaml <<EOF
services:
  pi-ez-web:
    volumes:
      - restored-data:/data
volumes:
  restored-data:
    external: true
    name: $restore_volume
EOF
docker compose -f compose.yaml -f compose.restore.yaml up -d --no-build
```

Inspect the restored state and retain the untracked `compose.restore.yaml` for
subsequent starts. Bare `docker compose` selects the original volume again, so
use both files for every later backup, upgrade, rollback, stop, and start:

```sh
export COMPOSE_FILE=compose.yaml:compose.restore.yaml
docker compose up -d --no-build
```

Do not delete the original volume until the restore is verified. Never use
`docker compose down --volumes` as a backup step.

## Configuration and trusted inputs

See [configuration.md](configuration.md) for the complete JSON and environment
reference. In particular:

- `PI_WEB_HOME`, `PI_CODING_AGENT_DIR`, and `PI_WEB_REPOS_ROOT` should be
  explicit absolute paths in containers.
- `project.environment` stores only destination/source variable names and
  resolves values at command spawn. A missing source prevents the command from
  starting; an empty source remains an intentional empty value.
- Mappings, hooks, Pi profiles, packages, extensions, and prestart commands are
  trusted execution inputs, not project isolation. They run as the service user.
- A Compose `.env` entry is not passed to the service unless Compose references
  it in `environment` or an `env_file`.

## Security boundary

There is no built-in authentication or sandbox. Pi, project hooks, and trusted
extensions can execute shell commands with the service user's authority. Keep
the default loopback binding, or put the service behind a TLS/authenticated
reverse proxy reachable only from a trusted LAN or tailnet/VPN. Do not
port-forward it or expose it directly to the public internet. Do not treat
separate projects in one instance as mutually untrusted tenants.

If a reverse proxy is used, proxy all paths—including `/api` and the long-lived
SSE endpoint—and preserve streaming responses. The proxy, not pi-ez-web,
provides authentication and public TLS.

## Health, upgrades, and rollback

Use `/ui-health` for a process/UI check. The full server also exposes
`/api/health`, which reports the API contract, build ID, capabilities, and sync
state. A successful TCP connection alone is not an application health check.

Run one application process (one replica). The supervisor, SSE hub, OAuth
flow state, and workspace locks are in memory, so horizontal replicas are not
a supported deployment shape.

For a local image upgrade, retain the previous tag and keep the data volume:

```sh
docker tag pi-ez-web:local pi-ez-web:previous
docker compose build --pull
docker compose up -d --no-build
curl --fail http://127.0.0.1:3141/ui-health
```

Rollback without deleting state:

```sh
PI_WEB_IMAGE=pi-ez-web:previous docker compose up -d --no-build
```

Test upgrades against a copy of the volume when possible; validate provider
login, Git clone/fetch, worktree creation, project hooks, and transcript
continuity after restart.

## Optional pi-sync

pi-sync is optional product functionality for handing canonical chat sessions
between laptop Pi sessions and web clients. It is not working-tree
synchronization. It transfers session JSONL and conversation metadata, not dirty
files, commits, patches, worktrees, stash state, or credentials.

Provide `PI_SYNC_SERVER_URL` to the web process and the pi-sync extension. The
extension also accepts `PI_SYNC_URL`; a config-only `sync.serverUrl` should not
be assumed to configure extension attachment. Keep sync disabled unless a
compatible sync server and client module are deliberately provisioned.
