# Container and homelab deployment

The repository includes a production-oriented `Dockerfile` for the real Pi
server. It runs as the unprivileged `node` user and listens on port `3141`.
The image installs the Pi SDK from the application's production dependencies,
so the real supervisor can import it at runtime.

```sh
docker build -t pi-ez-web:local .
docker run --rm -p 3141:3141 pi-ez-web:local
```

A real deployment must provide Pi credentials and persistent storage. Keep
these paths stable across container restarts:

The repository also contains `deploy/k8s-preview`, a frontend-only,
production-backed preview workload. The infra repository creates an Argo CD
Application that follows the internal `preview/pi` deployment ref and its
immutable GHCR digest; preview resources are name-prefixed so they do not select
the production pod. Feature branch builds replace the preview slot. Main builds
replace it too, wait until `/ui-health` reports the source commit, then promote
the same image digest to `deploy/k8s`. The main gate connects through
`tailscale/github-action` using the `TAILSCALE_OAUTH_CLIENT_ID` and
`TAILSCALE_OAUTH_CLIENT_SECRET` repository secrets. The preview runs with
`PI_WEB_UI_ONLY=1`, mounts no
application state or operator Secret, and serves `/ui-health` for Kubernetes
probes. The preview origin's `/api/*` requests are routed by the infra-owned
Caddy configuration to the production Service, while all other paths go to the
preview UI Service. The old preview PVC/NFS export remains retained as rollback
state and is not mounted by the new workload.

For an isolated full-stack branch preview, the preview Service must receive both
normal requests and `/api/*` (including SSE). The preview workload runs the
same real server image as its UI, but uses the distinct
`pi-web-preview-state-parent-nfs` volume and `/data/.../preview` subpath. Production conversations, repositories,
worktrees, operator credentials, and Kubernetes API access are not mounted into
that workload. Provider authentication and Pi state belong to the preview
volume; deleting the replaceable preview slot is the explicit reset boundary.
The platform repository owns the Caddy route that selects this mode.

- `PI_WEB_HOME` — config, bindings, closed markers, GitHub auth, cached remote Pi profile, and chat scratch space.
- `PI_CODING_AGENT_DIR` — Pi transcripts and agent configuration/auth. Set it explicitly (for example `/data/pi-ez-agent`).
- `reposRoot` — the checked-out repositories.
- `worktreeRoot` — the configured root for app-created linked worktrees; existing worktrees are also discovered from Git.

The image includes `git` and CA certificates. GitHub private clones use HTTPS
and a temporary askpass helper; public GitHub clones use HTTPS without a token.
Clone processes ignore global/system Git URL rewrite configuration so a validated
HTTPS URL cannot silently become SSH. SSH keys are not managed by the app.

For containers, set `PI_WEB_HOME`, `PI_CODING_AGENT_DIR`, and configure
absolute paths such as `/data/repos` and `/data/worktrees`; do not rely on the
image user's default home paths. Repositories and worktrees must be writable by
the service user. Never bake credentials into the image.

A typical retained layout is:

```text
/data/pi-ez-web/config.json
/data/pi-ez-web/bindings.json
/data/pi-ez-web/github-auth.json
/data/pi-ez-web/chats/
/data/pi-ez-agent/auth.json
/data/pi-ez-agent/models.json
/data/pi-ez-agent/sessions/
/data/pi-ez-workspaces/
/data/pi-ez-worktrees/
```

Treat both `github-auth.json` and Pi's `auth.json` as secrets in backups. A
remote Pi profile configured in `config.json` can install and execute arbitrary
Pi packages as the service user; use only trusted HTTPS settings and package
sources.

### Trusted prestart command

Set `PI_WEB_PRESTART_COMMAND` to an optional, deployment-controlled multiline
shell command when the operator home needs initialization before Pi starts. The
server runs it synchronously with `/bin/sh -c` before reading `config.json`,
creating the supervisor, or listening. Its stdout and stderr go to the
container logs, stdin is closed, and `PI_WEB_PRESTART_TIMEOUT_MS` sets the
positive-integer timeout (120 seconds by default). A blank command is ignored;
a timeout or nonzero exit aborts startup.

The command inherits `HOME`, XDG variables, `PI_WEB_HOME`, and
`PI_CODING_AGENT_DIR`. It is equivalent to trusted code execution as the
service user: keep it noninteractive, idempotent, and free of secret output.
It is not stored in `config.json`, exposed in Settings, or available through
the API. `createApp()` callers that bypass `startServer()` are responsible for
any equivalent initialization themselves.

The command is manager-agnostic. For example, deployments may use
`chezmoi apply`, GNU Stow, `rsync`, Nix/Home Manager, or a yadm sequence such as
`yadm clone --no-bootstrap --no-checkout` followed by a pinned `yadm reset
--hard`. The checked-in Kubernetes manifests use yadm and a pinned Bryan
dotfiles repository only as a deployment example; Pi EZ Web does not require
that repository or manager. Keep `PI_WEB_HOME` and `PI_CODING_AGENT_DIR`
separate from the projected operator home so application state, Pi sessions,
and credentials are not overwritten by dotfiles.

## k3s

The app is currently suitable for a single-pod k3s deployment, but it is not
horizontally scalable: the supervisor, SSE hub, and workspace locks are
in-memory. Use one replica (a `StatefulSet` or a `Deployment` with a recreate
strategy) and persistent volumes for the paths above. Configure `runAsUser`
and `fsGroup` so the `node` user can write the state, repository, and worktree
volumes.

The owned application resources live in `deploy/k8s/`, and the Argo CD
bootstrap resources live in `deploy/argocd/`. The release workflow builds one
private GHCR image, validates that digest in preview, records the verified digest
in `deploy/k8s/kustomization.yaml`, and lets Argo CD reconcile the committed
desired state. The namespace pull Secret
and runtime/operator Secrets are materialized out of band through fnox and
1Password; no secret values belong in Git or image layers. Site-specific
platform wiring such as Caddy routes, kubeconfigs, and the secret-sync task
remains in the platform repository.

A typical path is:

```text
Tailscale -> Caddy/Ingress -> pi-ez-web Service -> one pi-ez-web pod
                                               -> persistent state/repos/worktrees
```

Caddy can proxy the service directly:

```caddy
pi.example.ts.net {
    reverse_proxy pi-ez-web.default.svc.cluster.local:3141
}
```

Ensure the proxy permits long-lived SSE responses. GitHub device login and
provider flow state use server-side polling, so no pi-ez-web OAuth callback route
needs to be exposed through Caddy. Some Pi provider methods still use fixed
loopback callbacks; for a remote deployment prefer the device-code method when
available, or complete the provider's manual redirect/code prompt. Restrict
access with Tailscale ACLs and, if appropriate, an additional Caddy
authentication layer.
The application has no built-in authentication and the agent can execute shell
commands as its service user, so it must remain inside a trusted tailnet.

Test NFS-backed state for same-directory atomic rename, POSIX permissions,
Pi auth-file locking, Git clone, and Git worktree add/remove. Keep mount paths
stable because Git worktree metadata records absolute paths. Do not introduce a
second storage tier unless an acceptance test demonstrates a concrete NFS
failure.

The `/api/health` endpoint reports the REST contract, capabilities, and
commit-derived build ID for production rollout checks. UI-only previews use
`/ui-health` for their static process and receive production health through the
same-origin `/api/health` route. The browser polls health after SSE loss and
reloads once a new build is healthy, which supports a single-pod GitOps rollout.
Before treating this as a highly available service, add
external session/event coordination and graceful shutdown/drain handling. A
single persistent pod is the supported deployment shape today; OAuth flow
state, SSE clients, and workspace locks are in memory.
