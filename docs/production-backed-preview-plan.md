# Production-backed frontend preview plan

Status: preview conversion implemented in this branch; production-backed rollout remains an infra/app integration step.

## Context

The single preview slot should exercise branch UI code against the same
production pi-ez-web conversations, workspaces, providers, and sync adapter that
the normal UI uses. Running a second preview supervisor against production
files would violate the single-runtime and lease invariants. Maintaining a
separate preview Pi home also spends most preview startup time installing
packages and creates state that is unrelated to the UI being reviewed.

The preview will therefore become a frontend-only deployment. The preview
origin serves static assets from the selected branch image, while requests
under `/api` are routed to the production pi-ez-web Service. Production remains
the only backend process and the only client of `pi-syncd` for browser traffic.

This branch implements the UI-only process, the production-data banner, the
independent UI health/config endpoints, and the stateless preview workload.
The old preview PVC remains declared with Argo pruning disabled as rollback
state; it is no longer mounted by the preview pod.

## Application changes

Add a UI-only server mode selected by an environment value such as
`PI_WEB_UI_ONLY=1`.

In this mode `server/index.js` must:

- Skip `ensureHome`, config loading, workspace pruning, supervisor creation,
  provider initialization, and API route registration.
- Serve the branch image's `public/` and approved `/vendor/` assets with the
  existing no-cache/PWA behavior.
- Expose a small same-origin UI configuration document outside `/api`, for
  example `/ui-config.json`, containing `preview: true` and a production-data
  label.
- Provide a static-process health endpoint outside `/api` for Kubernetes probes,
  because `/api/health` belongs to the production backend at the preview origin.

Update the frontend shell to read the UI configuration and display a persistent,
compact banner:

```text
Preview UI · production data
```

All application API calls remain relative `/api/...`; the browser therefore
uses the preview origin and needs no CORS behavior. The SSE connection at
`/api/events` follows the same production route.

## Preview deployment changes

`deploy/k8s-preview` is now a stateless UI workload:

- Run the application image in UI-only mode.
- Remove the state initialization init container.
- Remove the state PVC mount and `/data` mounts. The old rollback PVC remains
  declared but is protected from Argo pruning.
- Remove Pi, repository, worktree, operator, Kubeconfig, provider, GitHub, Mise,
  and package-initialization environment.
- Remove operator Secret mounts.
- Keep one replica, immutable image selection, non-root security context,
  resource limits, and static-process probes.

The preview Service continues to select only the prefixed preview pod. The app
repository remains responsible for this generic stateless workload; the infra
repository owns the preview hostname's path routing.

Retain the current isolated preview state outside the new workload as rollback
data during migration. This plan does not require deleting its retained PV or
NFS directory.

## API compatibility workflow

A frontend-only preview consumes the API contract currently deployed in
production. Implement API changes with an expand-then-use sequence:

1. Add backward-compatible backend capability and deploy it to production.
2. Develop and preview the branch UI against that capability.
3. Promote the UI after validation.

Server changes continue to use unit, integration, and local browser tests before
production. A future explicitly isolated full-stack environment may be added
only when a backend change cannot be exercised through that workflow; it must
not mount production state.

The existing browser event contract version remains the compatibility guard. A
preview branch that expects a different contract should fail clearly rather
than reinterpret production events.

## Routing contract for infra

The preview origin requires path-based routing:

```text
pi.preview.bry-guy.net/api/*   -> production pi-ez-web Service
pi.preview.bry-guy.net/*       -> preview UI Service
```

SSE proxy settings must preserve long-lived streaming responses. Static health
checks address the preview UI Service directly; production health remains
available through the preview origin's `/api/health` path.

Because the preview JavaScript can invoke production mutation APIs, server-side
validation and existing confirmations remain the safety boundary. The banner
must make that production-data relationship unambiguous.

## Tests

- UI-only startup performs no state-directory creation, package initialization,
  supervisor import, or provider access.
- Static assets and `/ui-config.json` are served from the branch image.
- Static health is independent of production API health.
- A test reverse proxy routes state, transcript, mutation, and SSE requests to a
  mock production backend without CORS.
- The service worker remains scoped to the preview origin and does not cache API
  responses.
- The production-data banner appears in desktop, mobile, and PWA layouts.
- Kubernetes manifest tests assert the absence of preview PVC mounts, operator
  Secret mounts, and Pi runtime mounts; the retained rollback PVC remains
  explicitly protected from pruning.

## Delivery sequence

1. Refactor static asset serving into a UI-only app constructor.
2. Add UI configuration and the production-data banner.
3. Add proxy-routing integration tests with the mock backend.
4. Convert `deploy/k8s-preview` to the stateless UI workload. **Done in this
   branch.**
5. Land the infra path split and verify SSE through the preview hostname.
6. Keep the old preview state retained until the new preview has passed normal
   branch rollouts and production mutations through the alternate UI.
