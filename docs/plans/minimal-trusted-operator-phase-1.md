# Phase 1: minimal trusted-operator dogfooding

Status: planned

## Outcome

Run `pi-ez-web` as a persistent, single-user operator workstation that can prepare and work on both `pi-ez-web` and `infra`. The deployer, configured repositories, hooks, server, and agent are one trust boundary.

## Project-hook contract

Configuration supports deployment-wide defaults and per-project overrides:

```json
{
  "projectHooks": {
    "setup": "mise trust --yes && mise install",
    "check": "mise run check"
  },
  "projects": [
    {
      "id": "p_pi_ez_web",
      "name": "pi-ez-web",
      "repoPath": "/data/pi-ez-workspaces/pi-ez-web",
      "mode": "auto",
      "hooks": {
        "setup": "mise trust --yes && mise install && mise run bootstrap"
      }
    }
  ]
}
```

Another deployment can configure `./script/install`, `./script/check`, or any other shell command. `setup` is the only lifecycle name: it runs after connecting a repository and after creating a worktree. Every configured hook can also be run manually against the current session workspace.

Hooks run synchronously under `/bin/sh`, with the workspace as `cwd` and the operator process environment inherited. There are no approval prompts, hashes, provisioning records, queues, timeouts, or duplicate-run controls in this phase. A failed setup is reported but does not undo a successful clone, worktree, branch, or session creation.

## Changeset 1 — project hooks

App repository changes:

1. Add `server/hooks.js` to resolve effective hooks and run one command in a supplied workspace.
2. Replace the legacy `project.setup` behavior, which currently runs only on forks and hides failures.
3. Make workspace creation report whether a worktree was newly created.
4. Run `setup` after:
   - connecting a local or cloned repository;
   - branch creation that creates a worktree;
   - session forks.
5. Add `POST /api/sessions/:id/hooks/:name` for manual execution in that session's workspace.
6. Expose effective hook names, but not command strings, in project state.
7. Add a small current-project **Hooks** menu. Show exit status and output; automatic setup failures open the same result view.
8. Add the `project-hooks` API capability and document configuration.

Hook output is returned only to the requesting browser, is not persisted or written to server logs, and passes through the existing credential redaction rules before crossing HTTP.

Tests cover command/cwd/environment behavior, success and failure output, default/override resolution, each creation path, no-hook behavior, manual invocation, and browser result rendering.

Gate: `mise run check`.

## Changeset 2 — operator-capable app runtime

1. Extend the deployed image with a pinned Mise binary and bootstrap packages: Git, OpenSSH client, Bash, curl, CA certificates, Python, jq, rsync, OpenSSL, archive utilities, and basic native build support.
2. Keep repository-versioned tools out of the image; project setup hooks install them.
3. Set persistent `HOME` and Mise/XDG directories under `/data/pi-ez-operator-home`.
4. Inject the Git commit as `PI_WEB_BUILD_ID` during the image build.
5. Add a Git credential helper that reads the existing pi-ez-web GitHub OAuth file, answers only for HTTPS `github.com`, and stops working after GitHub logout.
6. Configure deployment-owned Git identity as `Bryan Smith <bryan@bry-guy.net>`.

Tests verify image contents/configuration, persistent path wiring, build ID injection, helper host restrictions, and that credentials never enter remotes or command arguments.

## Changeset 3 — operator deployment and infra portability

Work in an isolated infra worktree.

1. Add an admin-side Mise task that creates/updates a Kubernetes Secret from:
   - the locally resolved `OP_SERVICE_ACCOUNT_TOKEN`;
   - the two existing kubeconfig files.
2. Use mode-0600 temporary files and `kubectl create secret --from-file --dry-run=client | kubectl apply`; do not emit secret values.
3. Update the Deployment to:
   - read the 1Password token through `secretKeyRef`;
   - mount kubeconfigs read-only under `/run/secrets/pi-ez-web`;
   - persist the operator home on the existing PVC;
   - retain `automountServiceAccountToken: false`.
4. Add `op` to `infra/mise.toml` and add `mise.operator.toml` for Linux kubeconfig paths and `PI_EZ_WEB_REPO_ROOT`.
5. Add a repository-level `check` task suitable for the configured hook.
6. Add tailnet DNS forwarding for `tail9e13b.ts.net` through MagicDNS so kubeconfig and SSH hostnames work unchanged.
7. Add a self-deploy apply mode that submits the Deployment update without waiting inside the pod; the browser reconnects after the `Recreate` rollout.
8. Update infra tests and deployment documentation.

No SSH private key is mounted permanently. Existing fnox-backed tasks obtain keys and other task credentials from 1Password when invoked.

## Changeset 4 — onboard and prove dogfooding

1. Deploy from the laptop and verify the commit-derived health build ID.
2. Configure `pi-ez-web` and `infra` as `auto` projects with their hook commands.
3. Connect private `infra`, then run setup in both checkout and worktree sessions.
4. Run each project's configured check hook.
5. Verify Git fetch, branch commit, and push for both repositories.
6. Verify `fnox`, both kubeconfigs, read-only infrastructure plans/status, and SSH connectivity.
7. Build and apply a pi-ez-web revision from the operator pod, reconnect, and verify the new build ID and healthy rollout.
8. Review Git remotes, manifests, pod environment descriptions, and logs for accidental credential persistence or disclosure.

## Deferred

- Repository trust prompts or approvals
- Declaration hashes and invalidation tracking
- Persisted provisioning state or background jobs
- Hook concurrency controls, timeouts, and output caps
- Application authentication or narrower tailnet policy
- Separate operator image variants
- Per-project containers/Dev Containers
- Task-specific credentials and approval gates
- Automated rollback orchestration
