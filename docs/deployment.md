# Container and homelab deployment

The repository includes a production-oriented `Dockerfile` for the real Pi
server. It runs as the unprivileged `node` user and listens on port `3141`.
The image installs the Pi SDK explicitly because the application declares it as
a peer dependency for local development.

```sh
docker build -t pi-ez-web:local .
docker run --rm -p 3141:3141 pi-ez-web:local
```

A real deployment must provide Pi credentials and persistent storage. Keep
these paths stable across container restarts:

- `PI_WEB_HOME` — config, bindings, closed markers, and chat scratch space.
- `/home/node/.pi/agent` — Pi transcripts and agent configuration/auth.
- `reposRoot` — the checked-out repositories.
- `worktreeRoot` — Git worktrees created by the app.

For containers, set `PI_WEB_HOME` and configure absolute paths such as
`/data/repos` and `/data/worktrees`; do not rely on the image user's default
home paths. Repositories and worktrees must be writable by the service user.
Never bake credentials into the image.

## k3s

The app is currently suitable for a single-pod k3s deployment, but it is not
horizontally scalable: the supervisor, SSE hub, and workspace locks are
in-memory. Use one replica (a `StatefulSet` or a `Deployment` with a recreate
strategy) and persistent volumes for the paths above. Configure `runAsUser`
and `fsGroup` so the `node` user can write the state, repository, and worktree
volumes.

Keep cluster-specific Kubernetes resources outside this application repository,
for example in `~/dev/infra`: PVC and storage-class choices, Tailscale
Operator configuration, Caddy/Ingress, hostnames, ACLs, and secrets are
site-specific. This repository documents the image and its storage contract;
it does not need to contain the k3s manifests.

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

Ensure the proxy permits long-lived SSE responses. Restrict access with
Tailscale ACLs and, if appropriate, an additional Caddy authentication layer.
The application has no built-in authentication and the agent can execute shell
commands as its service user, so it must remain inside a trusted tailnet.

Before treating this as a highly available service, add external session/event
coordination, a readiness endpoint, and graceful shutdown/drain handling. A
single persistent pod is the supported deployment shape today.
