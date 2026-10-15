# workspaced

The control plane. It creates, wakes, sleeps and deletes one worker per project and proxies web's requests to them. It is `node workspaced/index.js` from the same pi-ez-web image, on port 3150. It is the only component that needs a Kubernetes client, and the most privileged one: it can do whatever its largest grant allows.

## Providers

| `WORKSPACED_PROVIDER` | Workers are | Isolation |
| --- | --- | --- |
| `local` (default) | Child processes in workspaced's container, state under `WORKSPACED_ROOT` | None: one user, one HOME, one trust zone. Grants are recorded, not enforced |
| `kubernetes` | A Deployment, Service and PVC named `ws-<project>` each | Own pod, volume and ServiceAccount, enforced grants, NetworkPolicy-ready labels |

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3150` | Listen port |
| `WORKSPACED_TOKEN` | required | Bearer token web must send |
| `WORKSPACED_AUTH` | `token` | `network` drops the token and trusts a NetworkPolicy that admits only web. Use it only where policies are enforced |
| `WORKSPACED_MAX_AWAKE` | `3` | At most this many workers run at once. Waking another puts the least recently used idle one to sleep (never a pinned or busy one). `0` disables. Sleeping keeps the volume; background processes stop unless the project is pinned *Keep awake* |
| `WORKSPACED_IDLE_MINUTES` | `0` (off) | Optionally also sleep any worker after this long without use |
| `WORKSPACED_GRANTS` | `{"default":{"anyProject":true}}` | Grant shapes as JSON, see below |
| `WORKSPACED_ROOT` | `~/.pi-ez-workspaces` | local: where workers' state lives |
| `WORKSPACED_NAMESPACE` | `pi-ez-workspaces` | kubernetes: home namespace for workers |
| `WORKSPACE_IMAGE` | `ghcr.io/bry-guy/pi-ez-web:latest` | kubernetes: worker image. Pin a digest |
| `WORKSPACE_IMAGE_PULL_SECRET` | unset | kubernetes: pull Secret name |
| `WORKSPACE_STORAGE` / `WORKSPACE_STORAGE_CLASS` | `20Gi` / cluster default | kubernetes: each worker's PVC |
| `WORKSPACE_ENV_CONFIGMAP` | unset | kubernetes: ConfigMap loaded into every worker's environment, e.g. `PI_WEB_PRESTART_COMMAND` |

workspaced's own ServiceAccount needs, in each worker namespace: create/get/list/patch/delete on Deployments, Services and PVCs, plus create/update on the two auth Secrets `pi-ez-github-auth` and `pi-ez-model-auth`. It does not need to create ServiceAccounts, Roles or other Secrets.

## Grants

A grant says what a project's worker may hold. The deployer defines grants; a user picks one when adding a repository, and the sidebar shows it read-only. A repository-locked grant refuses other repositories, also when a worker wakes.

```json
{
  "default": { "anyProject": true, "description": "No secrets, internet only." },
  "deployer": {
    "repos": ["you/infra"],
    "serviceAccount": "infra-operator",
    "env": ["operator-env"],
    "namespace": "pi-ez-workspaces",
    "egress": "open",
    "runtimeClass": null,
    "description": "Cluster access and deploy secrets for the infra repo only."
  }
}
```

| Field | Effect on the worker (kubernetes) |
| --- | --- |
| `anyProject` / `repos` | Who may use it; a `default` grant is required |
| `serviceAccount` | Pod ServiceAccount, token mounted. You create it and its RBAC |
| `env` | Secret names loaded with `envFrom` (optional, so they may be filled later) |
| `namespace` | Where the worker runs |
| `egress` | Value of the pod label `pi-ez.dev/egress`, for your NetworkPolicies to match |
| `runtimeClass` | Pod RuntimeClass, e.g. a VM sandbox |

How Secrets get filled (kubectl, External Secrets, a CI job) is your choice. Workers never talk to a secret manager; they see plain environment variables.

## API

All routes need `Authorization: Bearer $WORKSPACED_TOKEN`. `GET /v1/workspaces`, `POST /v1/workspaces`, `DELETE /v1/workspaces/:name`, `POST …/:name/wake|sleep|restart`, `PUT …/:name/pin`, `PUT …/:name/grant`, `GET /v1/grants`, `PUT /v1/github-auth`, `PUT /v1/model-auth`, and `/w/:name/*`, which proxies to the worker. Requests to a sleeping worker wake it and wait about 45 s, or return `503 workspace_starting` with `Retry-After`. A worker that cannot start (crash loop, out of memory, no node can schedule it, a sandbox that has not booted after 3 minutes) returns `503 workspace_failed` with a `problem` right away, and `GET /v1/workspaces` reports the same `problem` per worker. Wakes run one at a time so start-up memory spikes don't stack.
