# Authentication, session, and picker follow-up

Status: investigation complete; implementation pending

## Goals

- Make GitHub, Anthropic, and OpenAI authentication start from an obvious in-app login action.
- Keep acquired credentials on the server; never require ordinary users to inject long-lived tokens at startup.
- Show the authenticated account and the configured default GitHub owner without conflating them.
- Make a newly used project session remain visible at the top of its project.
- Give unnamed web sessions a durable automatic name after their first prompt.
- Keep the model picker compact, bounded by the viewport, and internally scrollable.
- Detect an incompatible/stale backend instead of rendering controls that cannot work.

## Investigation findings

### 1. The currently running frontend and backend are from different revisions

The process listening on port `3141` was started on 2026-08-09 at 22:04, before
commits `4594cf9`, `d0dac83`, and `acc78a0`. Hono's route table is loaded into
that process at startup, but static files are read from the working tree on each
request. The result is a new frontend talking to an old backend.

Observed on `3141`:

- `/api/state` has none of `providers`, `repositorySources`, `settings`, or
  `effectiveDefaultModel`.
- `/api/repository-sources` returns 404.
- `/api/github/repos` returns 404.
- New settings controls can render from frontend defaults even though their
  backend does not exist.

A second instance of the current code on port `3142` exposed all of those fields
and routes. This version skew explains why the new configuration looks plausible
but GitHub/provider actions do not work.

Immediate operational remedy: restart the process on `3141`. The implementation
below must also make this failure explicit if it happens again.

### 2. GitHub is neither configured nor authenticated

Current local state has no `~/.pi-web-ui/github-auth.json`, and the current
`~/.pi-web-ui/config.json` has no GitHub owner or OAuth client ID. Against the
current backend, `POST /api/github/device-login` therefore returns:

```json
{"error":"github_not_configured"}
```

The public GitHub API confirms that `bry-guy/pi-ez-web` exists and is currently
the most recently updated public repository for `bry-guy`. The repository is
not missing from GitHub; the picker never reaches an authenticated repository
request.

The current UI also has the wrong abstraction boundary: it asks an ordinary
user for an OAuth client ID before showing a login button.

GitHub's device authorization flow **does require a client ID**. A client ID is
a public application identifier, not a credential or long-lived user secret.
There is no valid GitHub device flow with no application identity. The
low-friction solution is:

1. Register one OAuth App for pi-ez-web and enable Device Flow.
2. Ship that app's public client ID as the built-in default.
3. Keep environment/config overrides for forks or custom deployments, but hide
   them from the normal settings screen.
4. Never ship or request a client secret; device flow does not need one.

Without a project-owned built-in client ID, an operator must configure a client
ID once. That is the unavoidable fallback, not the desired user experience.
The implementation hides this field from the UI and keeps the advanced
`PI_WEB_GITHUB_CLIENT_ID`/config override, but a project-owned ID still needs to
be registered and supplied before one-click GitHub login can work in a clean
release.

### 3. AI login and durable token storage already work in the current backend

The current backend reports:

- Anthropic: stored OAuth credential, connected, 13 available models.
- OpenAI Codex: stored OAuth credential, connected, 7 available models.
- OpenAI API: not connected; supports an in-app API-key prompt.

Starting and cancelling the current flows confirmed:

- Anthropic produces an authorization URL plus a manual-code/redirect prompt.
- OpenAI Codex offers browser or device-code login.
- The Pi SDK persists successful credentials under
  `PI_CODING_AGENT_DIR/auth.json`.
- API-key values submitted in the UI are passed directly to the SDK interaction
  and are not returned in browser state.

Thus the backend mechanism already satisfies the no-startup-secret requirement.
The visible failure on `3141` is version skew, followed by a UX/labeling problem.

Provider distinctions must remain explicit internally:

- `anthropic`: Claude Pro/Max OAuth or Anthropic API key.
- `openai-codex`: ChatGPT Plus/Pro OAuth.
- `openai`: OpenAI API key; Pi exposes no OpenAI API OAuth method.

For a remote k3s deployment, prefer OpenAI's device-code path. Anthropic's SDK
flow uses a fixed localhost callback; when the browser is on another machine,
the user must paste the final redirect URL/code into the app. The UI and
`docs/deployment.md` need to state that accurately.

### 4. A Date comparator makes new project sessions appear to disappear

`SessionManager.list()` returns `Date` objects in real mode. `server/domain.js`
currently sorts with:

```js
String(b.modified).localeCompare(String(a.modified))
```

A JavaScript `Date` string starts with the weekday, so this is not chronological.
Mock tests did not expose the bug because the mock supervisor stores ISO strings.

On the live `infra` project, the newest session was:

```text
019fef4a-61e2-74ca-8d95-32d56ccb049e
2026-08-11T05:28:36.182Z
```

Chronologically it belongs at index 0. The current comparator put it at index
19. The browser initially inserts a new session at the top as `New session`;
a later state refresh moves it far down the sidebar, which looks like deletion.
The transcript and session file remain intact.

There is a second recency issue: a normal turn does not update/reorder sidebar
state unless some other event causes a full state refresh.

### 5. Session titles are fallback text, not durable automatic names

Pi 0.84 has explicit naming (`--name`, `/name`, `setSessionName()` and
`appendSessionInfo()`), but no configuration option that automatically names
every conversation.

pi-ez-web currently displays `session.name || firstMessage.slice(0, 48)`. The
browser also replaces `New session` with the first prompt in memory after a
`user_record`. That fallback survives reload, but it does not create a Pi
session name, so terminal-created and web-created sessions remain formally
unnamed.

The sorting bug is the primary cause of the apparent erasure. Durable automatic
naming is still worthwhile and should be implemented separately.

### 6. The model list cap is overridden with an unbounded inline value

CSS gives `.model-list` a `max-height` of 240px, but `positionPopover()` writes
an inline maximum based on all available room:

```js
Math.max(120, availableRoom - gap)
```

When there is substantial room above the composer, that inline value can be
hundreds of pixels and overrides the CSS cap. The popover therefore grows much
larger than intended instead of scrolling at a compact fixed size.

### 7. Browser tooling status

This checkout has no Playwright dependency, no cached Playwright browser, and
no Chrome/Chromium installation. Safari is installed. No tool was installed or
machine configuration changed during this investigation. HTTP interaction,
current-code API probes, SDK inspection, and the live timestamp data were
sufficient to isolate the failures. A real-browser geometry test is included in
the implementation plan.

## Implementation plan

### WEB-301 — Detect and prevent frontend/backend version skew

1. Add a REST contract/build marker to `/api/state`, separate from transcript
   SSE contract v1, for example:

   ```json
   {
     "apiContractVersion": 2,
     "capabilities": ["provider-auth", "github-device-auth", "repository-sources"]
   }
   ```

2. Make `refreshState()` validate the contract and required capabilities before
   rendering Settings or repository-source controls.
3. If incompatible, show a blocking message such as “The server is running an
   older build; restart pi-ez-web,” rather than silently substituting empty
   defaults.
4. Validate settings response fields before displaying “saved.”
5. Add a development command using Node watch mode so edits to server modules
   restart the local process. Keep production startup unchanged.
6. Add a readiness/version endpoint suitable for deployment rollout checks.
7. Document that a source update requires a process/container restart.

Acceptance:

- A new frontend against a pre-contract backend shows one explicit restart
  error and does not claim settings were saved.
- A matching build renders normally.
- Transcript SSE remains contract v1.

### WEB-302 — Make GitHub login a first-class account action

External prerequisite:

- Register a project-owned GitHub OAuth App, enable Device Flow, and obtain its
  public client ID.

Server/config changes:

1. Add the project client ID as the built-in default.
2. Preserve precedence for an advanced override:
   environment > config override > built-in ID.
3. Do not include the effective client ID in normal `/api/state` settings data.
4. Retain `repositorySources.github.owner` as the editable default owner. It is
   a repository filter, not the authenticated identity.
5. Make GitHub status explicit: `signed_out`, `connected`, `invalid`, or
   `environment_managed`, plus verified account login when available.
6. Require `/user` validation before a newly acquired token is reported as
   connected. Cache validation briefly rather than calling GitHub on every
   state request.
7. Keep the token only in `github-auth.json` with mode 0600. Never return it to
   the browser or place it in Git URLs/argv.

Settings UX:

1. Replace the client-ID field with a GitHub account card:
   - signed out: **Sign in with GitHub**;
   - connected: **Connected as bry-guy**, **Change account**, **Sign out**;
   - environment managed: show read-only source and no sign-out action.
2. Start device flow from the button and show a focused dialog with:
   verification URL, copyable code, “Open GitHub,” cancel, and progress.
3. Keep **Default GitHub owner** as an ordinary editable setting, prefilled from
   config and showing whether config or environment controls it.
4. Explain that changing the default owner filters repositories; changing the
   signed-in account requires sign-out/re-login.
5. Move any custom OAuth client-ID override to documented advanced config only.

Picker changes:

1. Show the current account in the GitHub source header.
2. If signed out, show the login CTA directly; do not show “OAuth not
   configured” in a normal release with a built-in client ID.
3. After login completes, refresh status and load repositories automatically.
4. Apply the configured default owner initially, while allowing “All accessible”
   or another owner in the picker without rewriting login identity.
5. Implement pagination/load-more; the current server returns `nextPage` but the
   browser discards it.
6. Optionally list a configured owner's public repositories while signed out,
   clearly marking that login is required for private repositories. This is a
   convenience, not a substitute for login.
7. Keep clone authentication in temporary `GIT_ASKPASS` exactly as today.

Security decision:

- Classic OAuth App scope `repo` is broad but is the simplest way to clone all
  private repositories. The consent UI must disclose it. A GitHub App could use
  read-only Contents permission but adds installation/repository-selection UX;
  evaluate that separately rather than mixing it into this fix.

Acceptance:

- On a clean install, GitHub Settings contains no client-ID input.
- Clicking Sign in starts a valid device flow without server token injection.
- Completing it persists a token server-side and displays the verified account.
- With default owner `bry-guy`, `bry-guy/pi-ez-web` appears in the picker.
- A private repository can be selected and cloned without credential material
  in browser state, logs, URL, argv, or process listings.
- Sign out removes only app-managed GitHub auth.

### WEB-303 — Simplify Anthropic and OpenAI login UX

1. Keep the current Pi `ModelRuntime.login()` and `auth.json` persistence path.
2. Present user-oriented provider actions:
   - Anthropic: **Sign in with Anthropic**; secondary **Use API key**.
   - OpenAI: **Sign in with ChatGPT** backed by `openai-codex`; secondary
     **Use OpenAI API key** backed by `openai`.
3. The UI may visually group the two OpenAI credential paths while retaining
   their distinct provider IDs and models.
4. Prefer OpenAI device-code login for remote/headless deployments; put browser
   callback login under an alternate-method action.
5. For Anthropic, open the authorization page and keep the manual redirect/code
   input visible with clear remote-server instructions.
6. Show `Connected`, auth type, model count, reconnect, and disconnect states.
   Do not imply an account identity when the SDK does not expose one.
7. After completion/logout, refresh provider status and models atomically so the
   picker does not briefly show stale choices.
8. Preserve one globally active provider login flow because SDK callback ports
   are fixed.
9. Correct deployment documentation: frontend polling transports flow state,
   but some provider flows still use loopback callbacks or manual code entry.

Acceptance:

- A clean deployment can acquire and retain Anthropic OAuth, ChatGPT OAuth, or
  an API key entirely through Settings.
- No long-lived AI token must be present in startup environment variables.
- Reload/restart retains app-acquired credentials from
  `PI_CODING_AGENT_DIR/auth.json`.
- Submitted API keys and OAuth tokens never appear in REST responses, browser
  state, or logs.

### WEB-304 — Sort session families by real activity time

1. Normalize timestamps numerically:

   ```js
   const epoch = value => value instanceof Date
     ? value.getTime()
     : Date.parse(value) || 0;
   ```

2. Replace lexical Date sorting with descending numeric sorting and a stable ID
   tie-breaker.
3. Add an ISO `updatedAt` field to session/chat state; keep `when` display-only.
4. For a top-level fork family, compute `activityAt` as the newest timestamp in
   that root's subtree. Sort top-level families by `activityAt`; sort children
   among siblings without flattening lineage.
5. On `user_record`, update the active node/root activity in browser state and
   reorder immediately. Do not run the expensive full `/api/state` discovery
   after every token or delta.
6. Ensure external-client activity delivered over SSE produces the same reorder.
7. Keep server ordering canonical so reload produces the same result.

Acceptance:

- Real `Date` instances and ISO strings sort identically.
- The live newest `infra` session appears first, not at index 19.
- Sending a first message does not make a new project session appear to vanish.
- Activity in a forked child moves its top-level family to the top while
  preserving the child tree.
- Chats and project sessions use the same recency semantics.

### WEB-305 — Use the existing first-message fallback; defer naming to extensions

Do not write a pi-ez-web-specific `session_info` name. Pi extensions can add a
shared naming policy later, and a second naming authority would make terminal
Pi and web titles disagree.

1. Keep Pi's explicit `name` field authoritative when one already exists.
2. For unnamed sessions, display the beginning of `firstMessage` using one
   shared compact helper: collapse whitespace, trim, and cap the text to the
   sidebar display length.
3. Apply the same fallback to project sessions and plain chats, including
   sessions created by the terminal.
4. Do not make a hidden model request or append metadata merely to name a
   session.
5. Keep the existing API-only rename endpoint for explicit future controls.

Acceptance:

- A new session may display `New session` until its first prompt is recorded,
  then displays a deterministic truncation of the start of that prompt.
- Reload and terminal Pi discovery use the same fallback text.
- Later prompts do not rename an already explicitly named session.
- A `model_required` rejection does not consume/erase the draft.

### WEB-306 — Bound and compact the model picker

1. Make the popover approximately 260px wide with denser group labels and rows.
2. Cap the list to a small fixed target (for example 220–240px) **and** the
   available viewport room:

   ```js
   maxListHeight = Math.min(COMPACT_LIST_CAP, availableRoomAfterHeader)
   ```

3. Cap the whole popover to `calc(100dvh - 24px)` and keep only `.model-list`
   scrollable.
4. Remove the current inline value that can exceed the CSS cap.
5. Keep the selected option scrolled into view and preserve keyboard navigation.
6. Reposition above/below without any edge crossing the viewport on desktop or
   mobile.

Acceptance:

- With 20+ models at 1280x720 and 390x844, the popover remains fully inside the
  viewport.
- The list has `scrollHeight > clientHeight` and can reach its final option.
- Opening from Settings and the composer behaves consistently.
- Escape/outside-click/focus behavior remains intact.

## Test plan

Credential-free automated tests:

- Domain tests with actual `Date` objects, ISO strings, equal timestamps, and a
  recently active descendant.
- HTTP tests for API version/capabilities and stale-client response validation.
- DOM tests for GitHub signed-out/connected/invalid states, no client-ID field,
  owner editing, login completion, logout, and repository pagination.
- Auth tests confirming only account metadata—not tokens/codes—is exposed.
- Session tests confirming automatic name persistence and no overwrite.
- Model-picker DOM tests confirming the computed cap never exceeds the compact
  constant.

Real-browser gate:

- Add an explicit Playwright test or manual gate for popover geometry, scrolling,
  account dialogs, focus, and mobile layout. Installing Playwright/Chromium is a
  separate project-local tooling decision; it was not performed during this
  investigation.

Explicit credentialed checks:

- GitHub device login, account validation, public/private listing, clone, and
  logout.
- Anthropic same-host OAuth and remote/manual-code flow.
- OpenAI Codex device flow and token persistence after restart.
- OpenAI/Anthropic API-key entry with response/log redaction checks.
- One-pod k3s restart with persistent auth files.

## Recommended order

1. Restart the existing `3141` process so the already-implemented routes can be
   evaluated honestly.
2. Implement WEB-301 and WEB-304 first; they explain the currently broken
   controls and disappearing-session symptom.
3. Register the GitHub OAuth App, then implement WEB-302.
4. Refine AI-provider UX in WEB-303 without replacing the working SDK storage.
5. Add durable deterministic names in WEB-305.
6. Compact and browser-test the model picker in WEB-306.
7. Run explicit real-provider/GitHub/k3s validation; keep normal tests
   credential-free.
