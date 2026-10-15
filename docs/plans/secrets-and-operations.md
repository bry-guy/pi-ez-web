# Secrets, grants and operations

Status: agreed 2026-10-15. Phase 1 in progress.

## Model
Apps read env vars and never call 1Password. A repo declares variable
*names* (`fnox.toml`); it can't grant itself anything. Laptop: `fnox
activate zsh` resolves them from desktop 1Password, per environment profile.

The pi-ez-web deployer defines **grant shapes** in deploy code. pi-ez-web
knows only Kubernetes primitives, nothing about 1Password or ESO:

```yaml
grants:
  default:  { anyProject: true }                      # no secrets
  preview:  { anyProject: true, env: [preview-env], egress: preview }
  operator: { repos: [bry-guy/infra], namespace: pi-ez-operator,
              serviceAccount: infra-operator, env: [operator-env], egress: open }
```

- Projects are never listed in deploy code. Add any repo in the UI and pick
  a grant it may use: any `anyProject` grant, or one whose `repos` match.
- Powerful grants are repo-locked; assignable-anywhere grants are low-power
  by design. workspaced validates, cannot create or widen grants (no RBAC
  for SAs/Roles/Secrets in grant namespaces), and the UI shows each grant.
- Secrets behind a grant are filled however the deployer likes (ESO in this
  homelab).
- "Dev secrets" = bindings to a named environment (shared preview now,
  per-branch later). Never prod.

## Known residual risk
workspaced can create pods in grant namespaces, so a compromised workspaced
holds the biggest grant. Mitigated by network: only pi-web reaches
workspaced; only Caddy reaches pi-web; workers can't reach either.
Stricter (admission policy) is later.

## Phases
1. Network: pi-web ingress only from Caddy; worker egress = internet, DNS,
   pi-sync (deny 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16).
2. Grant shapes: ConfigMap read by workspaced; grant stored as a
   Deployment annotation, re-validated on wake; namespace/SA/envFrom/egress
   from the grant; UI picker + read-only view. Changing namespace re-clones.
3. Infra worker: `pi-ez-operator` namespace, `infra-operator`
   (cluster-admin), `operator-env` = `OP_SERVICE_ACCOUNT_TOKEN` scoped to a
   new `infra-ops` vault (created once from the Mac), node SSH key. Prove it
   by releasing to preview. Retire in-process infra.
4. Later: preview grants, finances pilot, srvivor/pi-sync, drop castaway's
   ambient OP token, remove in-process projects.

Unverified: node SSH from a pod via LAN IP (phase 3).
