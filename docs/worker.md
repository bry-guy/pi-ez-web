# worker

One per project. A worker is the same server as [web](web.md), running the Pi SDK in-process against a single cloned repository, with that project's tools and secrets. workspaced starts it; you never deploy one by hand.

## What a worker gets

| From | What |
| --- | --- |
| workspaced | `PORT=3141`, `PI_WEB_HOME`, `PI_CODING_AGENT_DIR`, `PI_WEB_REPOS_ROOT` on its own volume; `PI_WEB_GITHUB_AUTH_FILE` and `PI_WEB_MODEL_AUTH_FILE` pointing at the logins web shared |
| `WORKSPACE_ENV_CONFIGMAP` | Shared environment, typically `PI_WEB_PRESTART_COMMAND` (dotfiles, default setup hook) and `PI_SYNC_SERVER_URL` |
| its grant | ServiceAccount, `envFrom` Secrets, namespace, egress label, RuntimeClass. See [grants](workspaced.md#grants) |
| the repository | Its own tools: `mise.toml`, `script/bootstrap`, `gradlew`, whatever the project uses. The **setup** hook (e.g. `mise trust --yes && mise install`) installs them once after cloning |

## The image

Workers use the pi-ez-web image (`WORKSPACE_IMAGE`). It ships git, ssh, curl, jq, build tools, Node 22 and [mise](https://mise.jdx.dev). Project-specific tools such as Go, kubectl or a Docker CLI come from the repository's `mise.toml`, not the image. If a project needs OS packages mise can't install, build a derived image and point `WORKSPACE_IMAGE` at it:

```dockerfile
FROM ghcr.io/bry-guy/pi-ez-web:sha-<commit>
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
USER node
```

## Lifecycle

When more than `WORKSPACED_MAX_AWAKE` workers would run, the least recently used idle one sleeps: its volume stays, its processes stop, and the next request wakes it. Expanding or opening a sleeping project in the sidebar starts waking it right away. After start, a worker preloads Pi and its extensions in the background, and keeps compiled extensions in `~/.cache/pi-ez-web/jiti` so restarts don't recompile them. A worker is busy, and never put to sleep, while an agent turn, compaction or queued prompt is running. Pin a project with **Keep awake** to keep dev servers running.

## Health

`GET /api/health` returns `ok`, `buildId` and `busy`. It is the readiness probe.
