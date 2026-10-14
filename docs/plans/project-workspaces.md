# Project workspaces on Kubernetes

Status: superseded by [workspaced.md](workspaced.md); the gateway as front door is replaced by web + workspaced + worker.

## Problem

Projects (Castaway, finances, infra) need the full SDLC — build, run, debug, profile, test, deploy — with their own tools and secrets. Growing one shared image and one shared trust boundary does not scale and does not compose.

## Decision

Run **one unmodified pi-ez-web server per project** in its own Kubernetes pod, behind a thin **gateway**.

```text
browser → gateway (/, /api/gateway/*, /w/<name>/* proxy)
            ├→ ws-castaway  Deployment + PVC + Service   [runtimeClass kata + dind sidecar] [secret] [SA ws-castaway]
            ├→ ws-finances  Deployment + PVC + Service                                      [secret] [SA ws-finances]
            └→ ws-infra     Deployment + PVC + Service                                      [secret] [SA ws-infra]
```

- **Native Pi feel is preserved.** Each pod runs the existing server with the Pi SDK in-process, so extensions, settings, and dotfiles behave exactly as in the Pi CLI. No RPC split.
- **Adding a repository spins up a workspace.** The gateway creates `ws-<name>` resources on demand and the pod connects the repository itself (`PI_WEB_SEED_REPOSITORY`), running the project's `setup` hook. No redeploy, no per-project image.
- **Workspaces are durable.** The PVC (`/data`) holds the checkout, worktrees, `HOME`, tool caches, sessions, and Docker data. Deleting a workspace keeps the PVC unless purged.

## Layers and owners

| Layer | Examples | Owner |
| --- | --- | --- |
| Personal | dotfiles, Pi extensions, Git identity | Operator: `WORKSPACE_ENV_CONFIGMAP` (e.g. `PI_WEB_PRESTART_COMMAND`) applied to every workspace |
| Project tools | `mise.toml`, `script/bootstrap`, `./gradlew` | Repository, run by the `setup` hook (deployment default: `mise trust --yes && mise install`; workspace-only tools in `mise.pi-ez.toml` via `MISE_ENV=pi-ez`) |
| Workspace | image, storage, containers opt-in | Gateway config and the create request |
| Grants | 1Password service account, cluster access | Operator/infra: `secretName`, optional `ws-<name>` ServiceAccount |
| GitHub | one login for all workspaces | Gateway device flow, stored in Secret `pi-ez-github-auth`, mounted read-only into every workspace (`PI_WEB_GITHUB_AUTH_FILE`) |

pi-ez-web never creates RBAC or Secrets. A `ws-<name>` ServiceAccount, if an operator created one, is used automatically; otherwise the pod gets no Kubernetes token.

## Containers (Docker Compose)

Projects that need Docker opt into a sandbox runtime class (Kata Containers). The pod then gets a `docker:dind` sidecar sharing its network namespace, so `docker compose up` works unchanged and published ports are reachable on `localhost`. The privileged sidecar is only ever emitted with a runtime class: the VM boundary, not the container, is the isolation. The project supplies the Docker CLI/Compose (e.g. via Mise); `DOCKER_HOST` is preset.

## Trust boundaries (option C)

- One credential zone per workspace: its secret, its ServiceAccount, nothing else.
- Apps own their `deploy/k8s` manifests, applied by Argo CD; deploying is a `git push`.
- Platform changes (namespaces, databases, ingress, DNS) remain in `infra` and are proposed by pull request from app workspaces.
- Production debugging uses a read-only `ws-<name>` ServiceAccount scoped to the app's namespace (example in the infra repo, copied from the operator Role).

## Gateway contract

Environment: `GATEWAY_NAMESPACE` (default `pi-ez-workspaces`), `WORKSPACE_IMAGE`, `WORKSPACE_STORAGE` (`20Gi`), `WORKSPACE_STORAGE_CLASS`, `WORKSPACE_ENV_CONFIGMAP`, `WORKSPACE_IMAGE_PULL_SECRET`, `PORT` (`3150`).

Gateway ServiceAccount needs, in its namespace only: `deployments` (apps) and `services`, `persistentvolumeclaims` — get/list/watch/create/delete; `serviceaccounts` — get; `secrets` — create, plus get/update/delete on `pi-ez-github-auth` only. No other Secret or RBAC access. Resource caps are the namespace's LimitRange/ResourceQuota, owned by the deployment.

The UI resolves API paths against `document.baseURI`, so it works at `/` and under `/w/<name>/`.

## Not yet done

- Authentication remains the network boundary (tailnet/Caddy), as today.
- Opening a workspace's dev server (e.g. Castaway web on `:8080`) from the browser; today use `kubectl port-forward` or `curl` from the workspace.
- Per-workspace NetworkPolicy.
