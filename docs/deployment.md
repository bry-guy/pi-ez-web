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

The repository also contains `deploy/k8s-preview`, an ephemeral-state preview
workload. The infra repository creates an Argo CD Application for a selected
branch and overrides its GHCR image with that branch commit's immutable tag;
preview resources are name-prefixed so they do not select the production pod.

- `PI_WEB_HOME` — config, bindings, closed markers, GitHub auth, and chat scratch space.
- `PI_CODING_AGENT_DIR` — Pi transcripts and agent configuration/auth. Set it explicitly (for example `/data/pi-ez-agent`).
- `reposRoot` — the checked-out repositories.
- `worktreeRoot` — Git worktrees created by the app.

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

Treat both `github-auth.json` and Pi's `auth.json` as secrets in backups.

## k3s

The app is currently suitable for a single-pod k3s deployment, but it is not
horizontally scalable: the supervisor, SSE hub, and workspace locks are
in-memory. Use one replica (a `StatefulSet` or a `Deployment` with a recreate
strategy) and persistent volumes for the paths above. Configure `runAsUser`
and `fsGroup` so the `node` user can write the state, repository, and worktree
volumes.

The owned application resources live in `deploy/k8s/`, and the Argo CD
bootstrap resources live in `deploy/argocd/`. The release workflow builds a
private GHCR image, records its immutable digest in `deploy/k8s/kustomization.yaml`,
and Argo CD reconciles the committed desired state. The namespace pull Secret
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
commit-derived build ID for rollout checks. The browser polls health after SSE
loss and reloads once a new build is healthy, which supports a single-pod
GitOps rollout. Before treating this as a highly available service, add
external session/event coordination and graceful shutdown/drain handling. A
single persistent pod is the supported deployment shape today; OAuth flow
state, SSE clients, and workspace locks are in memory.
