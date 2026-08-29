# pi-sync integration

Status: the real web runtime now loads the pi-sync extension through the Pi SDK
when a sync server is configured. `PiSyncWebAdapter` supplies browser dialogs,
extension status, and session replacement; the extension owns enrollment, leases,
heartbeat, ETags, materialization, and settled-session upload. The old web
coordinator remains available for mock-mode and compatibility tests while the
extension path is validated.

## Goals

- Keep `pi-syncd` as the canonical snapshot and lease authority.
- Make pi-ez-web a browser host for the same Pi extensions, skills, prompts,
and tools used by the CLI.
- Avoid duplicating pi-sync lifecycle logic in pi-ez-web.
- Preserve Git upstream, branch, and pushed-commit information in synchronized
session envelopes.
- Make synchronized conversation names sticky across clients.
- Warn about Git mismatches without fetching, switching branches, or blocking
Pi execution.

No change to upstream Pi is required. The web runtime embeds `AgentSession`
directly and uses its existing extension bindings.

## Runtime boundary

```text
pi-ez-web browser adapter
  AgentSession event rendering
  ExtensionUIContext over SSE/HTTP
  switchSession command action

Pi AgentSession
  configured profile, packages, extensions, skills, prompts, and tools
  pi-sync extension

pi-syncd
  canonical envelopes, ETags, and renewable exclusive leases
```

`PiSyncWebAdapter` is a host integration, not a second synchronization client.
It provides:

- `select`, `confirm`, `input`, and `editor` through browser dialogs;
- `notify`, status, title, and editor-text forwarding;
- the command context required by `/sync`, especially `switchSession`;
- safe status inspection for browser state;
- the configured web sync URL for the extension;
- best-effort all-conversation enrollment when that setting is enabled.

The adapter does not acquire leases, normalize envelopes, upload snapshots, or
perform Git mutations.

Arbitrary terminal `ctx.ui.custom()` components and terminal-only renderers are
not translated to HTML. Their underlying commands and tools may still load;
only the specialized TUI representation is unavailable.

## Extension loading

When `sync.serverUrl` is configured, the supervisor adds the installed
pi-sync extension to `DefaultResourceLoader`'s additional extension paths. The
extension's `resources_discover` handler supplies its synchronized-workspace
skill. All other configured Pi resources continue to be loaded through the
normal Pi profile/package mechanism.

The web runtime binds a browser UI context while retaining `mode: "json"`.
`ctx.hasUI` is therefore true for browser-capable dialogs without claiming that
the runtime is a terminal TUI.

## Synchronization behavior

The pi-sync extension is authoritative in the real web runtime:

1. `/sync attach` normalizes and enrolls the current native Pi session.
2. A normal prompt is intercepted by the extension's `input` handler.
3. The extension acquires the server lease and starts its heartbeat.
4. Pi runs the turn locally with the configured web workspace.
5. `agent_settled` normalizes and uploads the complete JSONL snapshot.
6. The extension releases the lease.
7. `/sync` lists sessions through the browser `select` dialog.
8. The extension materializes the selected canonical snapshot and calls
   `ctx.switchSession`; the web adapter replaces the active `AgentSession`.

The old `PiSyncCoordinator` is not installed in this path, so there is only one
live lease state machine for a web session. It remains for mock-mode behavior and
existing coordinator tests until extension-only end-to-end validation replaces
them.

The initial cutover gives prompt turns and explicit sync operations the
extension-owned lifecycle. Before a normal prompt, the web host asks the
extension to reconcile the local binding: an unchanged local copy is refreshed
from a newer canonical snapshot before the prompt runs, while genuine local
changes remain a conflict. Existing web-only durable operations that do not
enter Pi's prompt lifecycle remain local until a later prompt or explicit
synchronization operation. Automatic focus refresh is disabled in this path so
those local entries are not silently replaced.

The web's existing sync endpoints remain as thin compatibility surfaces:
manual enrollment and refresh invoke `/sync attach` and `/sync refresh` through
the actual extension, while status reads the extension binding and server
metadata without exposing lease tokens to browsers. Refresh remains available
explicitly; automatic focus refresh is disabled so web-only local entries are
not silently replaced before they are included in a later turn.

## Sticky names

For a synchronized binding with a title:

- enrollment records the current Pi session name;
- materialization records the canonical title;
- `session_start` restores the title through Pi's session API;
- later local name changes are immediately restored to the binding title;
- web `/name` preserves the synchronized title rather than creating a durable
  divergent name.

A future explicit canonical rename command may update the title under a lease;
that is not required for the initial integration.

## Git workspace pointers

The shared envelope carries the configured upstream remote, branch, and pushed
commit. Dirty state, local-only commits, patches, worktree paths, and stash
state are not transferred.

The `/sync` picker derives a normalized repository identity from the current
workspace and only offers canonical sessions with the same identity. A session
without a Git remote is treated as unscoped and is only offered from an
unscoped workspace. The identity ignores credentials and transport syntax, but
branch and commit remain advisory workspace details.

The extension performs read-only comparison and notifies when the current
workspace does not match the recorded pointer. It never:

- fetches;
- checks out or creates branches;
- merges or resets;
- transfers dirty files;
- blocks prompts or tools because of a mismatch.

When settling a turn, an existing pointer is retained if the current workspace
is on a different repository or branch. If the repository and branch match, a
new pushed upstream commit may advance the pointer. A session without a pointer
can acquire one when an upstream becomes available.

## Validation

The current tests cover browser `select`/`confirm`/`input`/`editor` request and
cancellation, command error propagation, Git pointer sanitization and
repository scoping, duplicate materialized-file selection, and the pi-sync
extension's lease/ETag lifecycle.
The remaining acceptance tests are:

- actual pi-sync `/sync attach`, prompt settlement, and `/sync refresh` through
  the web SDK runtime;
- browser `/sync` selection and `switchSession` replacement;
- sticky names across materialization and local rename attempts;
- Git pointer transfer and non-blocking mismatch notifications;
- representative third-party extensions and skills loading unchanged.

The existing coordinator tests continue to cover the compatibility fake and the
previous network lifecycle during the transition. They are not evidence that
the extension-only web path is complete.

## Explicit follow-up work

These are intentionally not part of the initial sync cutover:

- remove the compatibility coordinator after extension-only end-to-end tests;
- make browser built-in command adapters thinner around Pi SDK operations;
- expose Pi extension argument completions in the web composer;
- improve fallback rendering for custom extension messages and tool results;
- support text widgets and richer status placement;
- provide browser-specific renderers for extensions that require custom TUI
  components;
- add an explicit `/sync rename` or `/sync flush` operation;
- improve workspace selection and Git guidance without automatic Git changes;
- bring direct web-only durable mutations (for example bang records and
  compaction) into an explicit extension-owned flush lifecycle;
- reduce remaining transcript/event translation where the SDK event surface is
  sufficient.
