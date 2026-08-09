# Handoff: Pi Web UI — chat + projects control plane

## Overview

A self-hostable browser UI for orchestrating [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) sessions. Two core features:

1. **Chat** — a plain written conversation with the agent, with chat history.
2. **Projects** — a repo is attached to a project; conversations happen *in the context of that repo*, organized as a session tree where each session is associated with a git branch.

The intended deployment is the same shape as [`jmfederico/pi-web`](https://github.com/jmfederico/pi-web) (which the requester self-hosts today and wants to replace): a container/server process that owns long-lived Pi runtimes, with the browser as a control surface. **The UI is the thing being replaced — not the operating model.**

Read `ARCHITECTURE.md` next. It contains the actual engineering ask: plan a simple, robust Pi SDK integration to serve this UI, and evaluate web components + htmx honestly (pushback welcome and expected).

## About the design files

`design/Pi App.dc.html` is a **design reference**, not production code. It is a single-file React-class prototype ("Design Component") that renders the complete UI with fabricated data and a fake streaming loop. Open it in a browser to see and click the intended behavior.

**Do not port it as-is.** The task is to recreate this UI in whatever runtime the implementation settles on (see `ARCHITECTURE.md` for the web-components/htmx question). Every design decision below is expressed in terms the target runtime can satisfy.

Two things in the prototype are deliberately structured to survive the port:

- All view state lives in one flat object, derived into view values in a single function. That maps cleanly onto a custom element's `render()`.
- The transcript is a plain array of `{id, role, ...}` records where `role ∈ user | assistant | tool | diff | bang`. **This is the event contract.** Map Pi SDK stream events onto these five shapes and the transcript component needs no other input.

## Fidelity

**High-fidelity.** Colors, type, spacing, and interaction behavior are final and intentional. Recreate faithfully. The exact oklch values matter — they were tuned against pi.dev and checked for WCAG AA.

---

## Design tokens

All colors are oklch. Dark theme only — light mode was explicitly removed. Set `color-scheme: dark`.

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.152 0.013 252)` | App ground, message column |
| `--surface` | `oklch(0.184 0.015 252)` | Sidebar, cards, composer, panels |
| `--surface-2` | `oklch(0.223 0.017 252)` | User bubble, hover, inputs, tool output |
| `--surface-3` | `oklch(0.272 0.019 252)` | Avatar chip, scrollbar thumb |
| `--border` | `oklch(0.278 0.017 252)` | All 1px borders |
| `--text` | `oklch(0.958 0.004 250)` | Body text |
| `--muted` | `oklch(0.712 0.013 250)` | Secondary text, inactive rows |
| `--faint` | `oklch(0.612 0.015 250)` | Meta text, hints, timestamps, model chip |
| `--accent` | `oklch(0.538 0.086 240)` | Primary buttons, active session, tool names |
| `--accent-ink` | `oklch(0.982 0.004 240)` | Label on `--accent` fill |
| `--accent-soft` | `oklch(0.258 0.036 238)` | Active row background |
| `--orange` | `oklch(0.782 0.152 63)` | Git branch chips, bang `!` sigil |
| `--orange-soft` | `oklch(0.285 0.058 63)` | Branch chip background |
| `--pi-orange` | `oklch(0.722 0.168 52)` | Thinking π, streaming caret |
| `--green` | `oklch(0.755 0.135 158)` | Diff additions, connected status |
| `--red` | `oklch(0.685 0.158 24)` | Diff deletions, stop hover, close-button hover |
| `--danger` | `oklch(0.518 0.172 24)` | Destructive confirm button fill (AA with `--accent-ink`) |
| `--add-bg` | `oklch(0.238 0.048 158)` | Diff `+` line background |
| `--del-bg` | `oklch(0.232 0.046 22)` | Diff `−` line background |
| `--shadow` | `0 1px 2px oklch(0 0 0 / .4), 0 16px 40px oklch(0 0 0 / .45)` | Composer, panels, modals |

Measured contrast (all pass WCAG AA): accent-ink on accent **4.78:1**, faint on surface **4.97:1**, faint on surface-2 **4.58:1**, pi-orange on bg **7.55:1**.

**Color discipline — do not violate:**
- Blue (`--accent`) is the *only* interactive/primary color.
- Orange is reserved **exclusively for git branch identity** and bang commands. Never use it for buttons, links, or emphasis. This is what makes branch context catch the eye.
- `--pi-orange` appears only on the agent's activity indicators.

### Typography

- **UI:** IBM Plex Sans, weights 400 / 450 / 500 / 600.
- **Mono:** IBM Plex Mono, weights 400 / 500 / 600 — used for repo names, branch names, session tree, file tree, tool calls, diffs, model chip, timestamps, and all meta.

The mono/sans split is load-bearing: **anything that names a real thing on disk or in git is mono.** Prose is sans.

Scale: 20px/500 screen titles · 15px/500 sidebar wordmark · 14.5px/1.68 message body · 14px/500 header title · 13.5px settings rows · 13px sidebar chat rows · 12.5px project rows · 12px tool/diff/file rows · 11.5px mono meta · 11px branch chip, fork label · 10.5px hint · 11px/uppercase/0.09em section headers.

### Geometry

Radii: `999px` pills · `14px` composer + user bubble (`14px 14px 4px 14px`) · `13px` empty-state π tile · `12px` project cards · `10px` tool/diff/bang blocks + popovers · `9px` primary buttons, send button · `8px` header buttons, inputs · `7px` small buttons, branch rows · `6px` file rows, icon buttons · `5px` branch chips.

Spacing: sidebar `266px` (desktop) / `290px` (mobile drawer) / `56px` (mini rail) · file panel `288px` (desktop) / `302px` max 86% (mobile sheet) · thread column `max-width 760px`, padding `28px` desktop / `14px` mobile · message gap `22px` · header `min-height 54px`, padding `12px 16px`.

---

## Screens

### 1. Chat (plain conversation)

**Purpose:** a written conversation with no repo attached.

Layout: sidebar | main column (header, scrolling transcript, composer). Header shows the conversation title only — **no branch chip, no file-tree button, no fork affordance**. The composer is the full width of the 760px column.

Empty state: nothing but a 44px rounded tile (`--surface-2`, 1px `--border`, 13px radius) containing a 21px mono `π` in `--accent`, centered, `22vh` from the top. No headline, no suggestion chips — this was explicitly stripped.

### 2. Project chat

Same shell, plus:

- **Header:** title line, then a mono sub-line — `owner/repo` in `--muted`, a `·`, then the **branch chip**: a button in `--orange` on `--orange-soft`, 5px radius, with a `▾`. Clicking opens the branch popover.
- **Merge button:** immediately right of the branch chip — a bordered mono `merge`, transparent fill, `--faint`, hover → `--accent`. Project sessions only. Opens the merge confirmation.
- **Header right:** file-tree toggle — a bare mono `«` (expand) / `»` (collapse) glyph, 14px, borderless, `--faint`, `4px 6px` padding, hover `--surface-2` + `--text`. Visually identical to the sidebar's collapse button.
- **Fork affordance** on user messages (see Interactions).

### 3. Session tree (sidebar)

Two sections, uppercase 11px `--faint` headers with `0.09em` tracking:

- **PROJECTS** — each project is a mono row (repo name) with a `▾`/`▸` caret and a session count on the right. Expanding reveals its session tree: nested sans rows, one per session, indented by a `13px`-per-level left margin with a 1px `--border` guide line. Caret is `▾`/`▸` for nodes with children, `·` for leaves. **Sessions do not show branch chips in the sidebar** — branch lives in the chat header only.
- **CHATS** — flat list of plain conversations with a right-aligned relative timestamp in `--faint` mono.

Active row: `--accent-soft` background, `--text` color, weight 500.

**Close button:** a `×` in `--faint` (hover → `--red`) fades in on hover or keyboard focus of any *session* or *chat* row. It occupies layout permanently (`opacity` toggled) so rows never shift. Project rows have no close button. Clicking opens the close confirmation and must not also select the row — stop propagation.

Above both: a primary "New chat" button (`--accent` fill, `--accent-ink` label, 9px radius) and a search input that filters both sections.

Footer: 24px circular avatar, username, gear button.

### 4. Projects list

Header row: "Projects" (20px/500) with the subhead "One repo each. Sessions branch inside.", and a primary "Connect repo" button.

Cards (`--surface`, 1px `--border`, 12px radius, 14px/16px padding, hover → `--accent` border + `--shadow`): a 28px mono initial tile, the mono repo name, a sans blurb, and a right-aligned orange branch chip. Second row: mono meta in `--faint` — `N sessions · N branches · <relative time>`.

### 5. Repo picker (modal)

Centered over a `oklch(0.2 0.02 255 / .45)` scrim. 520px wide, `max-height 70vh` on desktop; full-width `80%`-height sheet on mobile. Header: "Select a repository", a `×`, an account chip (`bry-guy ▾`) and a "Find a repository" filter. Rows: mono repo name, `--faint` meta (language, updated), right-aligned visibility pill. Empty result state: "No repositories match."

### 6. File tree panel

Opens from the file-tree toggle, project sessions only. Right side: a static 288px column on desktop; an overlaid right sheet on mobile. Header: uppercase "FILES" + `×`. Rows are mono 12px, `13px`-per-level indent; directories are `--text` with `▾`/`▸` and `cursor: pointer`, files are `--muted` with a `·` and **are inert** — no viewer, by design. Directories sort before files, then alphabetical.

### 7. Settings

A single bordered card with rows: **Model** (mono chip, cycles), **Agent endpoint** (`/api/pi/stream`, read-only), **GitHub** (connection status + green dot). No appearance row — theme is fixed.

---

## Confirmation dialog

One shared component, 408px, `--surface`, 14px radius, over a `oklch(0.15 0.02 255 / .6)` scrim. Title (15px/500), body (13.5px/1.6 `--muted`), an optional warning callout, then a right-aligned button row: **Go back** (bordered, transparent, `--muted`) and the CTA.

Two uses, distinguished only by CTA fill:

| | Title | CTA | Fill |
|---|---|---|---|
| Merge | "Merge branch" | `Merge` | `--accent` |
| Close | "Close session" / "Close chat" | `Close session` / `Close chat` | `--danger` |

**Warning callout** — close confirmations only, and only when the session's branch is not `main`. `--orange` text on `--orange-soft`, mono 11.5px, 9px radius:

> The worktree for `<branch>` will be removed. Any changes on this branch will be lost.

This is the one place orange is used for warning rather than branch identity — justified because the thing being warned about *is* the branch. Merge confirmations never show it.

## Transcript components

### User message
Right-aligned, `max-width 82%`, `--surface-2` fill, 1px `--border`, radius `14px 14px 4px 14px`, `10px 14px` padding, 14.5px/1.6.

### Assistant message
Full width, no bubble, no avatar, no label. 14.5px/1.68, `text-wrap: pretty`, `white-space: pre-wrap`.

### Tool call (collapsed by default)
Bordered `--surface` block, 10px radius. Header row, all mono 12px: caret · tool name in `--accent` weight 500 · argument summary in `--muted`, truncated · right-aligned meta in `--faint` (`"6 matches · 0.4s"`). Expanded: a `--surface-2` `<pre>`, 11.5px/1.65, `--muted`, top border, left-padded to align under the name.

### Diff (collapsible)
Same block shell. Header: caret · `edit` in `--accent` · file path in `--muted` (truncated **from the left** — `direction: rtl` — so the filename stays visible) · `+18` in `--green` · `−4` in `--red`. Body: mono 11.5px/1.7 lines, each with a 14px sign gutter. `+` lines get `--add-bg`, `−` get `--del-bg`, hunk headers (`@@ …`) render in `--faint` with no background.

### Bang command (`!`)
Locally-executed shell, visually distinct from agent tool calls so the user can tell *who ran what*. Mono block: an orange `!` sigil, the command, right-aligned exit meta (`"exit 0 · 0.3s"`), then a `--surface-2` `<pre>` of stdout. Always expanded.

### Thinking indicator
Shown when a message is streaming **but has no text yet**. Its own line below the (empty) text, left-aligned, in a 30px box: a 24px mono `π` in `--pi-orange`.

It cycles through three animations, one per 4.6s cycle (~13/min — breathing rate), in order:

1. **`piImplode`** — holds still for the first 50%, then collapses to a point (scale 0.04, −190° rotation, 1px blur), blows outward past scale 2.3 to zero opacity + 4px blur, reappears at scale 0.18, and reassembles with a 1.12 overshoot. Easing `cubic-bezier(.7,0,.3,1)`.
2. **`piOrbit`** — holds to 42%, then rotates 360° while being pulled to scale 0.06 and back out through 1.35. Easing `cubic-bezier(.65,0,.35,1)`.
3. **`piBreathe`** — full-duration contract to 0.5 / opacity 0.3 / 0.9px blur, out through 1.18. `ease-in-out`.

The "hold, then one event per breath" structure is the point — it should not churn continuously.

### Streaming caret
Shown when a message is streaming **and has text**. An 8×16px `--pi-orange` bar, 1px radius, at the end of the text, `steps(1)` blink at 1.05s. The thinking π and the caret are mutually exclusive.

---

## Interactions

**Fork / rewind.** On hover (or keyboard focus) of a user message in a project session, a fork button fades in to the *left* of the bubble: 1px `--border`, `--surface`, a mono `⑂`, hover → `--accent`. Hovering the button itself expands it to also read `fork`. Because the row is right-aligned and the button precedes the bubble, the button always occupies layout (`opacity` toggled, not mounted/unmounted) and grows leftward — **the bubble must never move.** Focus must reveal it, not just hover.

Clicking forks: insert a new child node under the current session in the tree, carrying a new branch name derived from the parent's, seeded with the transcript truncated at that message, select it, expand the parent, and drop the rewound turn's text back into the composer.

**Branch popover.** Opens under the header branch chip. A fixed full-viewport scrim closes it. 272px, `--surface`, 10px radius. Sections: uppercase "SWITCH BRANCH" header · scrollable list (`max-height 210px`) of mono rows with a `✓` on the current branch and `default` meta on `main` · a footer with a `new-branch-name` mono input and a "Create" button. Enter in the input creates. Both paths set the branch for the current session. The popover must be out of flow so the header does not shift.

**Merge.** Confirming merges the session's branch into `main`; the session stays open and continues on `main` (its header chip updates). Not offered on plain chats or on sessions already on `main`.

**Close.** Confirming removes the session or chat from the sidebar. Child sessions in the tree are unaffected — only the closed node is hidden. If the closed row was the active one, select the project's first remaining session. Transcripts stay in session storage; this is a UI close, not a delete.

**Composer.** Textarea (2 rows, transparent, no resize) over a footer row: the hint in `--faint` mono 10.5px, then the **model chip** (borderless, transparent, `--faint`, hover → `--surface-2` + `--text`), then the send/stop button. The model chip must read as metadata, clearly subordinate to send. Enter sends, Shift+Enter newlines. Hint text switches while streaming to `Enter steers · Alt+Enter queues a follow-up` — matching Pi's real semantics. No repo/branch chip inside the composer.

**Send flow.** Append the user message and an empty assistant message with `streaming: true` → thinking π for ~2.4s → text streams in with the caret. **Stop during thinking must remove the empty assistant turn entirely** (not just clear the flag), or it leaves a blank gap; stop mid-stream keeps the partial text.

**Responsive.** Desktop: static sidebar, collapsible to a 56px mini rail (π / + / ▤ / ⚙). Mobile (390px frame): sidebar becomes a 290px overlay drawer with a scrim; the header gains a hamburger; the collapse `«` closes the drawer; the file panel becomes a right sheet; the thread column goes full-bleed at 14px padding.

---

## State

Flat and small — mirror this shape:

```
view              'chat' | 'projects' | 'settings'
projectId         active project
sessionId         active session within it
chatId            non-null when viewing a plain chat (mutually exclusive with project context)
railOpen          desktop sidebar
drawerOpen        mobile drawer
openTree {}       expanded project/session nodes
openTools {}      expanded tool-call/diff blocks
openDirs {}       expanded file-tree directories
branchOf {}       sessionId -> branch override
branchMenuOpen    branch popover
filesOpen         file panel
repoPickerOpen    modal
query, repoQuery, newBranch, draft
model
hoverMsg, hoverFork
hoverRow          sidebar row hovered/focused (reveals its close ×)
confirm           null | {type:'merge'|'close', kind, id, label, branch}
closed {}         closed session/chat ids
animIdx           thinking-animation rotation (interval, 4600ms)
```

`chatId` non-null ⇒ no branch chip, no file toggle, no fork button. That single flag is what separates the two core features.

## Assets

None. No images, no icon fonts, no SVG illustrations. Every glyph is a typographic character from IBM Plex Mono (`π « » ▾ ▸ ⑂ ✓ × ↑ + ⚙ ▤ ·`) except one hamburger drawn as three `<rect>`s. Fonts load from Google Fonts — self-host them for an air-gapped deployment.

## Files

- `design/pi-app-standalone.html` — **start here.** One self-contained file, no dependencies, works offline. Open it in any browser to see and click the entire UI.
- `design/Pi App.dc.html` + `design/support.js` — the editable source of the prototype. Reference only; `support.js` is not part of the deliverable.
- `ARCHITECTURE.md` — the Pi SDK integration brief. Start here for engineering.
