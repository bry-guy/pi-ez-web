# Architecture brief: serving this UI from Pi

**This document is the engineering ask.** The design is settled (see `README.md`); what is not settled is how to serve it. Produce a plan, not an implementation, and push back where the stated preferences are wrong.

## Goal

A **self-hostable** web app — one container / one `npm install -g` — that orchestrates Pi agent sessions and serves the UI in `design/`. It replaces [`jmfederico/pi-web`](https://github.com/jmfederico/pi-web), which the requester self-hosts today and rates as functionally good and visually unacceptable.

Bias: **absolute simplicity to start.** Prefer fewer moving parts over completeness. Anything that can be deferred, defer it and say so.

## Domain model

Adopt pi-web's three-level model — it's proven and it matches how the UI is already built:

```
Project     a repo on the server
Workspace   a git worktree (or the project folder itself for non-git / single-branch)
Session     a chat with Pi running inside a workspace, associated with a branch
```

Design-side mapping, already implemented in the prototype:

| UI concept | Server concept |
|---|---|
| Project (sidebar row, project card) | Project |
| Session (tree node) | Session |
| Branch chip in the chat header | The session's workspace/branch |
| Branch popover → switch | Select a different workspace |
| Branch popover → create | Create a workspace/worktree |
| Fork ⑂ on a user message | New session, branched from a point in the parent's history |
| Plain chat (CHATS section) | Session with no project/workspace binding |

The UI currently presents workspaces implicitly — the user sees *sessions with branches*, not a separate workspace tier. **Confirm this holds.** If a workspace tier must surface (e.g. two sessions sharing one worktree, or dirty-worktree conflicts), say where in the UI it belongs rather than inventing a screen.

**Worktrees:** acceptable if isolation requires them, but the requester prefers to start simple. Evaluate: is one-worktree-per-branch necessary at v1, or can sessions share the project checkout with a branch-switch guard until parallel sessions are actually used? State the failure mode of the simple path explicitly.

## Question 1: how does the server drive Pi?

Pi exposes four modes: interactive TUI, print/JSON, RPC (JSON over stdin/stdout), and SDK. The requester's assumption is **SDK**, and wants the tradeoffs argued rather than assumed.

Cover at minimum:

- **SDK** — in-process, typed events, direct access to session state. Couples the server's lifetime to the runtime's; a server restart kills active sessions unless the runtime is isolated in a separate process. `jmfederico/pi-web` solves this with a split architecture: a Fastify web/API process talking over a Unix socket to a long-lived **session daemon** that owns the SDK runtimes, so the UI can restart (and hot-reload in dev) without dropping agent work. Is that split warranted at v1, or is it the second thing to build?
- **RPC** — process isolation for free, language-agnostic, survives server restarts by design. Costs a serialization boundary and a supervision story (who spawns, restarts, reaps?).
- **Print/JSON (`pi -p`, `--mode json`)** — simplest possible; one process per turn. Almost certainly wrong for a persistent multi-session control plane, but worth stating *why* so the choice is defensible.
- **Interactive TUI** — not applicable; note and dismiss.

Recommend one, with the migration path if it's wrong.

**Constraints to respect:**
- Reuse existing Pi auth and model config from `~/.pi/agent` — no separate credential store.
- Persist sessions in Pi's own JSONL session storage. Do not build a second source of truth for transcripts.
- Keep app state minimal: pi-web stores only `projects.json` and discovers worktrees live via `git worktree list --porcelain`. Match that discipline.
- Pi sessions are **trees** (`/tree`, branch, rewind). The UI's fork affordance is a direct expression of this. Map the UI's fork onto Pi's native session-tree semantics rather than reimplementing branching.
- `@earendil-works/pi-coding-agent` should be a peer dependency with a range, not a pin.

## Question 2: web components + htmx — or not?

The requester's stated preference is **modern, simple web tech: web components, plus htmx if it fits.** Explicit invitation to push back with reasons.

The honest tension, which the plan must resolve rather than paper over:

- **htmx is request/response-shaped.** This UI is stream-shaped: token-by-token text, tool calls appearing mid-turn, diffs, status changes. htmx has SSE support, but the natural unit here is "append a delta to the last message" — which is a client-side state update, not an HTML swap. Streaming *server-rendered fragments* per delta is possible and worth evaluating honestly (it makes the transcript trivially resumable and keeps rendering in one place), but the per-token cost and the caret/thinking-indicator behavior need a real answer.
- **Web components fit well.** The transcript decomposes cleanly: `<pi-thread>`, `<pi-message>`, `<pi-tool-call>`, `<pi-diff>`, `<pi-bang>`, `<pi-session-tree>`, `<pi-branch-menu>`, `<pi-file-tree>`, `<pi-composer>`. Each is self-contained with a narrow prop surface. No framework needed.
- **A defensible hybrid:** htmx for navigation and CRUD (project list, repo picker, branch create, session create/fork — all genuine request/response), web components for the live transcript fed by one SSE or WebSocket stream. Evaluate this against "web components only" and say which is simpler *to maintain*, not just to write.

Note that `jmfederico/pi-web` uses **WebSocket** for realtime. SSE is simpler (one-directional, auto-reconnect, plain HTTP) and this UI's upstream traffic is low-volume (send prompt, stop, switch branch) — plain POSTs would cover it. Argue SSE vs WS explicitly; the Settings screen currently advertises `/api/pi/stream` as an SSE endpoint, and that's a placeholder, not a requirement.

**Non-negotiable regardless of stack:** no build step should be required to serve the app, sessions must survive browser disconnect, and reconnecting mid-turn must resume the transcript rather than restart it (`Last-Event-ID` or equivalent).

## Question 3: the event contract

The prototype's transcript is an array of records with `role ∈ user | assistant | tool | diff | bang`. Define the wire format that Pi's stream maps onto, covering at least:

- text deltas (append to last assistant message)
- tool call start / result / duration / expandable output
- file edits as structured diffs (path, +/− counts, hunk lines with signs)
- bang (`!`) commands — user-initiated local shell, must be visually and semantically distinct from agent tool calls; the UI already renders these differently on purpose
- turn lifecycle: thinking → streaming → done / stopped / errored (the UI has distinct indicators for thinking vs. streaming and must not show both)
- steering vs. follow-up (Enter vs. Alt+Enter — the composer hint already promises this)
- session/branch/model metadata changes

Version it. This contract is the seam between the UI and Pi; getting it right is most of the value.

## Deliverable

A plan document containing:

1. Recommended integration mode (SDK / RPC / other) with the tradeoffs argued and the process topology drawn.
2. A verdict on web components + htmx — adopt, adopt partially, or reject, with reasons. Rejection is an acceptable answer if it's argued.
3. Transport choice (SSE vs WebSocket) and the reconnect/resume story.
4. The event contract, versioned.
5. Persistence and state layout (what's on disk, what's discovered, what's in memory).
6. Worktree strategy for v1, with the deferred path named.
7. A build order — smallest thing that serves the chat screen end-to-end first, then projects, then the file tree.
8. Explicitly deferred: auth/multi-tenancy (assume trusted single user on a trusted server, as pi-web does), sandboxing, plugins.

## Out of scope

Do not redesign the UI. Colors, type, layout, and interaction behavior in `README.md` are final. If an architectural constraint genuinely forces a UI change, name it and propose the minimum change rather than substituting your own design.
