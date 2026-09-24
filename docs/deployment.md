# Deployment and maintenance

The Compose setup builds the app locally, binds it to localhost, and stores state in one named volume. See the [README](../README.md) to get started.

## Keep access private

pi-ez-web has no built-in authentication or sandbox. Anyone who can reach it can use its projects and run trusted commands with the service user's permissions. Keep the default `127.0.0.1` binding; do not expose the service directly to the internet.

For remote access, use an SSH tunnel or put the app behind a TLS- and authentication-protected reverse proxy on a trusted network. A proxy must pass through the long-lived `/api/events` stream without buffering. The proxy provides access control; pi-ez-web does not.

## Keep your data

Compose stores application settings, Pi credentials and transcripts, repositories, and worktrees in one named volume mounted at `/data`. `docker compose down` preserves it. **Do not use `docker compose down --volumes` to upgrade**; that deletes the volume.

Back up the volume before upgrading and protect the archive like a credential. The backup procedure below stops the service, discovers the project-scoped volume, and refuses to overwrite an existing archive. If backup fails, the app stays stopped; fix the cause before starting it again. The restore procedure extracts into a new volume and keeps the original intact. It archives only the `/data` volume; separately mounted host repositories need their own backups. Bind-mounted directories must be writable by container UID/GID 1000. Keep repository and worktree paths stable: Git worktrees record absolute paths.

Use the same Compose overrides for start, backup, restore, and upgrades. To make the examples below use an external local override, export `COMPOSE_FILE=compose.yaml:/path/to/compose.private.yaml` first. When restoring, put `compose.restore.yaml` last.

<details>
<summary>Back up the Compose volume</summary>

This stops the app, archives the volume read-only, and refuses to overwrite an existing archive. The backup directory defaults to `~/pi-ez-web-backups` and can be changed with `PI_EZ_WEB_BACKUP_DIR`.

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

</details>

<details>
<summary>Restore into a new volume</summary>

This keeps the original volume intact. Inspect the restored app before deleting any old data. The generated `compose.restore.yaml` is local deployment configuration; keep it out of version control.

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

If you use a local Compose override, place it between `compose.yaml` and `compose.restore.yaml` so the restore override comes last:

```sh
docker compose -f compose.yaml -f /path/to/compose.private.yaml -f compose.restore.yaml up -d --no-build
```

Bare `docker compose` selects the original volume again. Use both files on later starts and updates:

```sh
export COMPOSE_FILE=compose.yaml:compose.restore.yaml
docker compose up -d --no-build
```

With a local override, list it before the restore file, for example `export COMPOSE_FILE=compose.yaml:/path/to/compose.private.yaml:compose.restore.yaml`. Use that same list for backup, restore, and updates.

</details>

## Update and check health

After backing up, retain the current default image, then update and rebuild. If you use a custom image tag, retain that tag instead of `pi-ez-web:local`:

```sh
docker tag pi-ez-web:local pi-ez-web:previous
git pull
docker compose up --build -d
curl --fail http://127.0.0.1:3141/ui-health
curl --fail http://127.0.0.1:3141/api/health
```

These `--build` commands are for the default image; use the derived-image steps below if you customize it. Use the same Compose overrides as your normal start. The health checks below use the default host port; substitute your `PI_WEB_PORT` if it differs. `/ui-health` checks that the web process is running; `/api/health` checks the full server and reports its build and capabilities.

To roll back the image without rebuilding:

```sh
PI_WEB_IMAGE=pi-ez-web:previous docker compose up --no-build -d
```

Set `PI_WEB_IMAGE=pi-ez-web:previous` in `.env` to keep using it on later starts. Image rollback does not roll back the data volume; restore your backup if a new version changed stored data incompatibly.

Run one app instance. The session supervisor and event stream are in memory; multiple replicas are not supported.

## Custom tools for hooks

The public image does not include every command a project hook might need. Build a derived image for extra tools rather than adding a sidecar. Build the base image first:

```sh
docker build --build-arg PI_WEB_BUILD_ID=local --tag pi-ez-web:base .
```

Save this as `Dockerfile.hooks`:

```dockerfile
FROM pi-ez-web:base
USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
USER node
```

Build the derived image:

```sh
docker build --file Dockerfile.hooks --tag pi-ez-web:hooks .
```

Now set `PI_WEB_IMAGE=pi-ez-web:hooks` in `.env` and start without rebuilding:

```sh
docker compose up --no-build -d
```

Keep that `.env` value for later starts. After updating the source, rebuild the base and derived images in the same order. Do not use `docker compose up --build` while using a derived image: Compose would replace the derived tag with the base image. Hooks run with the app user's permissions; treat them as trusted code. See [Configuration](configuration.md) for the available settings.
