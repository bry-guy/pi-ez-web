# Secrets, grants and operations

Status: agreed 2026-10-15. Phases 1-3 live (d270cae); infra worker `ws-infra` on the operator grant ran release:plan with no 1Password.

## Model
Apps read env vars and never call 1Password. A repo declares variable
*names* in `fnox.toml` profiles; it can't grant itself anything. Tasks run
`fnox exec --profile <family> --no-defaults -- …`, so each task sees only its
family. Laptop: direnv (`.envrc`) supplies fnox's 1Password credential once
per shell. Worker: the grant's Secret already holds the values; fnox finds
no 1Password and leaves them in place. No worker ever talks to 1Password.

The pi-ez-web deployer defines **grant shapes** in deploy code. pi-ez-web
knows only Kubernetes primitives, nothing about 1Password or ESO:

```yaml
grants:
  default:  { anyProject: true }                      # no secrets
  preview:  { anyProject: true, env: [preview-env], egress: preview }
  operator: { repos: [bry-guy/infra], serviceAccount: infra-operator,
              env: [operator-env], egress: open }   # ghcr + platform profiles
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
3. Infra worker on the `operator` grant, in `pi-ez-workspaces` (a separate
   namespace adds nothing: workspaced holds the grant either way).
   `infra-operator` is cluster-admin; prestart turns any grant SA into
   `~/.kube/config`; infra's `mise.pi-ez.toml` points tasks at it.
   `operator-env` holds resolved values of the `ghcr` and `platform` profiles,
   written from the Mac by `mise run selfhost:platform:pi-ez-operator:env:apply`
   (re-run on rotation; ESO later). No 1Password token, no new vault. Prove
   it by releasing pi-ez-web to preview from the worker. Retire in-process
   infra.
4. Later: preview grants, finances pilot, srvivor/pi-sync, drop castaway's
   ambient OP token, remove in-process projects.

Not yet granted to the infra worker: node SSH, proxmox, cloudflare and other
profiles. Add a profile to `operator-env` only when a task needs it; each
widens what the infra agent can read.
