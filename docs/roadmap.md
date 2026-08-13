# Runtime environment roadmap

pi-ez-web should let repositories declare the tools and operating-system environment they need without permanently coupling those requirements to the web server. Repository declarations request an environment; deployment policy remains responsible for granting secrets, network access, kubeconfigs, and other privileges.

## Phase 1 — trusted operator and project hooks

The first dogfooding target is an explicitly trusted, single-user operator deployment. It is equivalent in authority to running Pi from an administrator workstation and must remain restricted to a trusted LAN or tailnet. See the [minimal Phase 1 implementation plan](plans/minimal-trusted-operator-phase-1.md).

- Give the deployed image the small bootstrap toolset needed to run project hooks; repositories remain responsible for declaring their versioned tools.
- Add generic per-project hooks in deployment-owned pi-ez-web configuration. A project may use Mise (`mise install`, `mise run bootstrap`, `mise run check`), repository scripts (`./script/install`, `./script/check`), or another tool without changing pi-ez-web.
- Run the configured install hook after connecting a checkout and creating a worktree, and allow it to be rerun manually. Run check and other configured hooks only when explicitly requested.
- Treat configured projects and hooks as trusted. Phase 1 does not add approval prompts, declaration hashing, invalidation tracking, or a provisioning state machine.
- Execute hooks in the selected project workspace, wait for completion, and surface their exit status and output directly.
- Support multiple projects and project-specific tool versions without rebuilding the pi-ez-web server image. Mise is the recommended dogfood implementation, not an application requirement.
- For the site-specific dogfood deployment, explicitly grant GitHub write access, Git identity, 1Password/fnox access, operator kubeconfigs, SSH/network access, and the tools needed by the `pi-ez-web` and `infra` repositories.
- Keep credentials out of images, source control, URLs, command arguments, API responses, and build logs. Treat the operator pod and its agent shell as part of the credential trust boundary.

## Phase 2 — Dev Container project environments

Adopt the standard `.devcontainer/devcontainer.json` plus Containerfile contract for requirements that Mise alone cannot express, including OS packages, native libraries, browser dependencies, and specialized build environments.

- Detect and report Dev Container declarations.
- Build a cached project runtime keyed by the declaration, base runtime, and relevant lockfiles.
- Run repository tools in that project runtime rather than rebuilding the shared pi-ez-web process.
- Keep build-time credentials stripped; grant runtime capabilities only after the image is built.

## Phase 3 — isolated execution and policy grants

Separate the web control plane from execution by running projects or sessions in dedicated runtime pods/containers.

- Map repository capability requests to administrator-controlled grants for secrets, network destinations, service accounts, kubeconfigs, and persistent storage.
- Add project-specific secret and NetworkPolicy boundaries, resource limits, and auditable execution identity.
- Support approval gates for destructive infrastructure actions.
- Preserve the Phase 1 project-hook contract and Phase 2 Dev Container declarations so repositories do not need another environment format.

## Non-goals

- Do not rebuild the monolithic pi-ez-web server whenever a project is added or its dependencies change.
- Do not allow a repository declaration to grant itself credentials or infrastructure privileges.
- Do not mistake hook configuration for a privilege grant; secrets and infrastructure access remain deployment-owned even though configured hooks are trusted.
