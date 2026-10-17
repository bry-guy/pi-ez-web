# Kubernetes deployment

Argo CD syncs these directories from `main`:

| Directory | Argo CD app | Serves |
|---|---|---|
| `web/` | `pi-ez-web` | `pi.bry-guy.net` |
| `workspaced/` | `pi-workspaced` | workspace gateway in `pi-workspaced` |
| `preview/` | `pi-ez-web-preview` | `pi.preview.bry-guy.net` (UI only; Caddy sends `/api` to production) |

Namespaces, storage, RBAC, network policy, and routing are platform-owned in `bry-guy/infra`.

`publish-image.yml` deploys on push via `scripts/deploy.sh`:

- `feature/**`: pin the built digest in `preview/`, wait for the preview to serve the commit.
- `main`: preview first, then `web/` and `workspaced/` in one commit, wait for production.

Rollback: `git revert` the `deploy(production): …` commit on `main`.
