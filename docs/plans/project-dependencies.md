# Proposal: project dependency management

Status: proposal, not implemented.

## Problem

pi-ez-web runs Pi, and every command Pi runs, inside one image. When a project needs a tool the image lacks, the work stops. Recent examples:

| Needed by | Tool | Symptom without it |
|---|---|---|
| pi-sync server and e2e tests | `go` | `spawnSync go ENOENT` |
| Browser checks of pi-ez-web | Chromium native libraries | `libglib-2.0.so.0: cannot open shared object file` |
| Cluster checks and releases | `kubectl` | command not found |
| GitHub reads and auth helper | `gh` | `gh: not found` |

Adding each tool to the image works once, but the image slowly turns into a copy of a workstation. Every project then pays for every other project's tools.

## Constraints

- Don't require every repository to adopt one ecosystem (for example Nix).
- Tools are binaries, not permissions. Installing `kubectl` must not grant cluster access, and installing `gh` must not grant a GitHub token. Credentials stay with the platform and are injected at runtime, never baked into an image or committed to a repository.
- Keep the shared mount out of tool caches when it can be avoided. `/data` is NFS. Locking and metadata-heavy caches are slower there and less proven.
- Prefer one obvious mechanism over several partial ones.

## Options

### A. Curated bundles in the image

```text
pi-ez-web image
├── base: Node, Pi, git, bash, certificates
├── bundle: go
├── bundle: browser   (Chromium + native libraries, Playwright browsers)
├── bundle: k8s       (kubectl)
└── bundle: github    (gh)
```

The image ships a small, reviewed set of bundles. Nothing is read from the project.

- Pros: simplest; fastest start; no runtime installs; works offline.
- Cons: still grows over time; every project gets every bundle; changing a version means rebuilding the image.

### B. Project tool manifest with a generic installer

```text
repository
└── .pi/tools.toml            go = "1.25", kubectl = "1.31", gh = "2", browser = "chromium"

pi-ez-web
├── reads .pi/tools.toml when a session opens
├── installs missing tools into a local cache keyed by name + version
└── starts Pi with those tools first on PATH
```

The installer would be backed by `mise` for language toolchains and CLIs, plus one built-in recipe for the browser bundle, because native libraries are not something `mise` provides.

- Pros: projects declare what they need; versions are pinned per project; the image stays small.
- Cons: first open of a project is slow; needs network access to download tools; native libraries need special handling; adds a manifest format to maintain.

### C. Repository bootstrap script

```text
repository
└── .pi/bootstrap.sh          e.g. `mise install && npx playwright install chromium`

pi-ez-web
└── runs it once per hash of the script (and of any lockfiles it lists), then starts Pi
```

- Pros: maximum flexibility; no new format.
- Cons: unstructured; easy to make slow or flaky; it is arbitrary code, so it must only run for repositories already trusted to run code; it cannot install OS libraries without root.

### D. Per-project runner image

```text
repository
└── .pi/runner.Dockerfile

pi-ez-web
└── builds or pulls that image and runs the session in its own pod
```

- Pros: exact OS-level dependencies; strong isolation between projects.
- Cons: needs an image build pipeline, a registry, and pod orchestration per session. That is a large change to how pi-ez-web runs Pi.

### E. Nix flake per project

```text
repository
├── flake.nix
└── flake.lock

pi-ez-web
└── starts Pi through `nix develop --command pi ...`
```

- Pros: fully reproducible, including native libraries and browsers.
- Cons: every project has to adopt Nix. That is ruled out by the constraints above.

### F. Capability workers

```text
pi-ez-web (slim)
└── sends browser, cluster, or build jobs to a separate worker that has the tools
```

- Pros: keeps the main pod small; heavy tools are isolated.
- Cons: more moving parts; jobs need a protocol and the user experience is harder to get right.

## Comparison

| | Image size | Project effort | Native libraries | Reproducible | Implementation cost |
|---|---|---|---|---|---|
| A. Bundles | grows slowly | none | yes | per image | low |
| B. Manifest | small | one file | special recipe | per manifest | medium |
| C. Bootstrap script | small | one script | no (no root) | weak | low–medium |
| D. Runner image | small | one Dockerfile | yes | yes | high |
| E. Nix | small | adopt Nix | yes | yes | medium |
| F. Workers | small | none | yes | per worker | high |

## Recommendation

1. **Now: option A.** Add four bundles to the image: `go`, `browser`, `k8s` and `github`. They are the tools pi-ez-web and pi-sync need to test and release themselves, so they earn their place. Credentials stay out of the image:
   - **`kubectl`:** use a narrowly scoped service account or kubeconfig, mounted at runtime.
   - **`gh`:** use a token from the existing secret injection.
2. **Later, only when another project needs a tool the bundles don't have: option B.** Start with `mise` behind `.pi/tools.toml`. Keep the browser as the one built-in native recipe. Keep the cache on local or ephemeral storage, not on `/data`.
3. **Avoid** runtime `apt install` (needs root, is mutable and not reproducible), and avoid mixing several of the options above at once.

## Work for option A

- Dockerfile:
  - Install Go.
  - Install `kubectl` and `gh` as pinned release binaries.
  - Install the Playwright Chromium dependencies (`npx playwright install --with-deps chromium`, or the equivalent package list).
- Test that the image can run `go version`, `kubectl version --client`, `gh --version`, and a headless Chromium launch.
- Platform (infra repository):
  - Mount a read-only, namespace-scoped kubeconfig only if cluster checks are wanted from pi-ez-web.
  - Inject a GitHub token only if pushes are wanted.

## Open questions

- Which cluster permissions, if any, should pi-ez-web sessions have? Read-only `get`/`logs`/`exec` in one namespace covers the checks done so far.
- Should pushes from pi-ez-web use a deploy key per repository or a fine-grained token?
