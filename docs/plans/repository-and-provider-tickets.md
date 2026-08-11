# Repository sources and model-provider remediation tickets

> **Status:** Proposed implementation plan. Nothing in this document describes
> current production behavior until its ticket is merged.
>
> **Audience:** A junior engineer implementing one reviewed ticket at a time,
> with mandatory senior review where marked.
>
> **Target:** `@earendil-works/pi-coding-agent@0.84.1`, Node 22, the existing
> zero-build browser application, and the existing Hono server.

## Outcome

Complete this epic to provide:

- reliable chat and project-session creation even when no AI provider works;
- useful errors instead of browser messages such as “The string did not match
  the expected pattern”;
- explicit model-provider status and authentication for Anthropic, OpenAI
  ChatGPT/Codex, and OpenAI API keys;
- a model picker with correct default semantics and no viewport clipping;
- Local, GitHub, and public Git URL choices in the project picker;
- GitHub device authentication, private-repository listing, and authenticated
  cloning; and
- a documented, single-replica container contract for persistent NFS-backed
  state.

## Scope decisions — do not redesign these inside a ticket

1. **Keep the architecture small.** Do not create a general provider plugin
   framework. The supported repository sources are `local`, `github`, and
   `git-url`. Pi remains the model-provider registry.
2. **Do not add an npm runtime dependency.** Use Node APIs, built-in `fetch`,
   the Pi SDK, and the `git` executable.
3. **Do not add authentication to pi-ez-web itself.** It remains restricted to
   a trusted tailnet/firewall. Provider credentials do not change that trust
   boundary.
4. **Do not put credentials in `config.json`.** Pi credentials remain in
   `PI_CODING_AGENT_DIR/auth.json`. GitHub credentials use a separate
   `PI_WEB_HOME/github-auth.json` file or an environment override.
5. **Do not put credentials in URLs, command arguments, logs, API responses, or
   browser state.** GitHub clone authentication uses a temporary
   `GIT_ASKPASS` helper and a child-process environment value.
6. **Do not change SSE contract version 1 for OAuth.** Authentication flows use
   short polling. Transcript events remain session-scoped SSE events.
7. **Do not add automatic chat scratch cleanup.** Existing scratch-retention
   behavior is unchanged. Temporary failed clone directories must be removed.
8. **Do not add SSH-key management.** `git-url` accepts public HTTPS URLs only
   in this epic. GitHub private repositories use GitHub OAuth over HTTPS.
9. **Do not add automatic pulls, background repository synchronization, PR
   creation, GitLab, Gitea, or Bitbucket.** Those are follow-up work.
10. **Keep normal checks credential-free.** `mise check` and `npm test` must not
    contact GitHub, Anthropic, or OpenAI.
11. **One pod remains the supported deployment.** Auth flows, the SSE hub, and
    workspace locks are process-local.
12. **“Repository sources” means accounts and ways to connect a project.** It
    does not mean editing arbitrary `git remote` entries. Git itself remains
    the source of truth for an existing checkout's `origin`.

## Work order

| Order | Ticket | Depends on | Senior checkpoint |
|---|---|---|---|
| 1 | WEB-201 — Error transport and model-independent sessions | — | Review detached Pi session persistence |
| 2 | WEB-202 — Effective model settings and unclipped picker | WEB-201 | Review default-model semantics |
| 3 | WEB-203 — Pi provider status and authentication | WEB-202 | **Required security review** |
| 4 | WEB-204 — Repository sources and GitHub private clones | WEB-201 | **Required security review** |
| 5 | WEB-205 — Configuration, container, docs, and acceptance | WEB-201–204 | Deployment review |

Do not begin WEB-203 or WEB-204 until WEB-201 is merged. WEB-203 and WEB-204
may proceed in parallel after their shared contracts are stable. Run
`mise check` before requesting review for every ticket.

## Shared response conventions

Expected application errors use JSON and an HTTP status appropriate to the
condition:

```json
{
  "error": "model_required",
  "message": "Connect a provider or choose an available model."
}
```

Unexpected errors never expose stack traces or arbitrary upstream response
bodies:

```json
{
  "error": "internal_error",
  "requestId": "65ef6068-6ac3-4ec6-b853-e2d1de62487f"
}
```

The complete stack and request ID go to the server log. A route may include a
safe, deliberately authored `message`; it must not return `error.message`
verbatim for unknown errors.

---

# WEB-201 — Structured errors and model-independent sessions

## User story

As a user, I can create and open a chat or project session before configuring
an AI provider. If I try to send a prompt without a usable model, the UI tells
me what to do. Server failures arrive as useful JSON rather than an opaque
browser exception.

## Why this comes first

The current routes eagerly ask the supervisor for a default model:

```js
await sup.createSession({ cwd: scratch, model: await sup.defaultModel() });
```

The real supervisor then initializes `ModelRuntime` and a full `AgentSession`.
That couples repository/chat lifecycle to provider configuration. The current
browser response helper also assumes every failed response is JSON, while Hono
has no application-level unknown-error handler.

The reported string-pattern error is **not yet proven** to be caused by an
empty model list. A malformed `models.json`, malformed proxy URL, or another URL
constructor could produce it. Preserve the original stack before selecting a
fix.

## Files

Expected changes:

- `server/index.js`
- `server/routes.js`
- `server/supervisor/real.js`
- `server/supervisor/mock.js`
- `public/js/api.js`
- `public/js/thread.js`
- `test/server.test.js`
- `test/sdk-surface.test.js`
- new `test/error-handling.test.js` if separation keeps tests clearer

Do not change provider-login UI in this ticket.

## Investigation task

Before changing session creation:

1. Reproduce `POST /api/chats` with the same effective deployment variables and
   Pi agent directory.
2. Record the HTTP status, response content type, safe response body, request
   ID, and server stack. Never paste credentials into the issue or test.
3. Validate that `PI_CODING_AGENT_DIR/models.json` is syntactically valid JSON.
   Inspect URL-shaped fields by key/name, but redact API keys and headers.
4. Check `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase equivalents
   for malformed URL values. Record only whether each is absent or parses as a
   URL; do not record credentials embedded in a proxy URL.
5. Add the smallest credential-free regression test that represents the
   discovered failure. If the deployment-only trigger cannot be reproduced,
   retain a test proving unknown failures still produce structured JSON.

The issue is not complete if the only change is replacing the browser error
text without preserving a server-side cause.

## Implementation tasks

### 1. Add request IDs and a Hono unknown-error handler

Use one request ID for the log, response header, and JSON response. Existing
route-level handling for expected errors may remain.

Illustrative implementation:

```js
// server/index.js
import { randomUUID } from "node:crypto";

app.use("/api/*", async (c, next) => {
  const requestId = randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

app.onError((error, c) => {
  const requestId = c.get("requestId") || randomUUID();
  console.error("pi-ez-web request failed", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    stack: error instanceof Error ? error.stack : String(error),
  });
  return c.json({ error: "internal_error", requestId }, 500);
});
```

Do not log request headers or request bodies from this generic handler; future
requests can contain API keys or OAuth codes.

### 2. Make the browser response parser content-type aware

Replace the current unconditional `r.json()` error path. It must handle JSON,
plain text, HTML proxy errors, empty `204` responses, and invalid JSON.

Illustrative implementation:

```js
// public/js/api.js
async function responseBody(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    return response.json().catch(() => ({}));
  }
  const text = await response.text().catch(() => "");
  return text ? { message: text.slice(0, 300) } : {};
}

const j = async response => {
  const body = await responseBody(response);
  if (!response.ok) {
    const code = body.error || `http_${response.status}`;
    const message = body.message ||
      (body.requestId ? `${code} (${body.requestId})` : code);
    throw Object.assign(new Error(message), body, {
      status: response.status,
      requestId: body.requestId || response.headers.get("x-request-id"),
    });
  }
  return body;
};
```

Do not display an upstream HTML error body directly in the composer. The final
implementation may replace non-JSON text with `HTTP <status>` rather than
showing it.

### 3. Persist a Pi session before creating an AgentSession

`RealSupervisor.createSession()` should create a `SessionManager`, persist its
header, register its path/metadata, and return. It must not initialize
`ModelRuntime`.

Pi 0.84.1 defers a new session file until entries are flushed. This repository
already uses the SDK's `_rewriteFile()` compatibility surface for bang
persistence and asserts it in `test/sdk-surface.test.js`. Extract that behavior
into one helper rather than duplicating it.

Illustrative implementation:

```js
function persistNewManager(manager) {
  const file = manager.getSessionFile?.();
  if (!file) throw Object.assign(
    new Error("session_persistence_unavailable"),
    { code: "session_persistence_unavailable" },
  );
  if (!fs.existsSync(file)) {
    if (typeof manager._rewriteFile !== "function") {
      throw Object.assign(
        new Error("session_persistence_unavailable"),
        { code: "session_persistence_unavailable" },
      );
    }
    manager._rewriteFile();
    // Pi's writer tracks whether later entries can append to this file.
    manager.flushed = true;
  }
  return file;
}

async createSession({ cwd, name }) {
  const { SessionManager } = await SDK();
  const manager = SessionManager.create(cwd);
  if (name) manager.appendSessionInfo(name);
  const file = persistNewManager(manager);
  const id = manager.getSessionId();
  this.paths.set(id, file);
  this.info.set(id, {
    id,
    path: file,
    cwd,
    name: name || null,
    parentSessionId: null,
  });
  return { id };
}
```

**Senior checkpoint:** Confirm the private SDK compatibility call remains
acceptable for 0.84.x. If Pi exposes a public flush API before implementation,
use that API and update `test/sdk-surface.test.js` instead.

### 4. Do not attach for read-only session operations

For a session that is not live:

- `transcript(id)` opens `SessionManager` and calls `entriesToRecords()`;
- `meta(id)` reads the manager and returns its recorded model or `null`;
- `setName(id, name)` appends session info through the manager;
- `bangRecord(id, record)` appends the custom entry through the manager;
- `rehome(id, cwd)` disposes a live session if necessary and updates metadata;
  the existing binding remains the durable cwd override.

Only prompt/model operations should need a live Pi `AgentSession`. This keeps a
broken provider configuration from blocking transcript display, branch
selection, naming, or bangs.

Example transcript fallback:

```js
async transcript(id) {
  const live = this.live.get(id);
  if (live) return snapshotRecords(live);
  await this._discover(id);
  const manager = this._managerFor(id);
  return entriesToRecords(manager.getBranch());
}
```

Preserve the canonical `entry_appended -> user_record` behavior. Do not append
user messages directly in a route or supervisor preflight.

### 5. Resolve a model only when attaching for a prompt or model change

Remove `model: await sup.defaultModel()` from all three creation routes:

- `POST /api/chats`
- `POST /api/projects`
- `POST /api/projects/:id/sessions`

When the first prompt attaches the runtime, apply the effective model rules
from WEB-202. Until WEB-202 lands, passing no explicit model is valid; Pi can
create an `AgentSession` whose `session.model` is undefined.

Before calling `session.prompt()`, fail synchronously if no model exists:

```js
if (!st.session.model) {
  throw Object.assign(new Error("model_required"), {
    code: "model_required",
  });
}
```

Map this in the message route:

```js
try {
  await sup.message(id, text.trim(), mode);
  return c.json({ ok: true });
} catch (error) {
  if (error.code === "model_required") {
    return err(c, 409, "model_required", {
      message: "Connect a provider or choose an available model.",
    });
  }
  throw error;
}
```

Do not emit `user_record` when this preflight fails. The draft should remain in
or be restored to the composer.

### 6. Give the browser an actionable no-model state

On `model_required`:

- restore the submitted draft;
- show “Connect a provider or choose a model in Settings”; and
- provide a Settings action if the current notification component can support
  one without broad refactoring. Otherwise the text is sufficient until
  WEB-203.

Do not render a fake assistant error record for a preflight rejection.

## API behavior

### Session creation with no provider

```http
POST /api/chats
```

```json
HTTP/1.1 200 OK
{"id":"8f7f..."}
```

### First prompt with no usable model

```http
POST /api/sessions/8f7f/message
content-type: application/json

{"text":"hello","mode":"prompt"}
```

```json
HTTP/1.1 409 Conflict
{
  "error": "model_required",
  "message": "Connect a provider or choose an available model."
}
```

## Tests

Add credential-free coverage for:

1. unknown route/supervisor exceptions return JSON `internal_error`, a request
   ID, and `x-request-id`;
2. the browser helper handles JSON, text, HTML, empty, and malformed responses;
3. a real `SessionManager` header is persisted without constructing
   `ModelRuntime`;
4. detached transcript/meta/name/bang operations do not attach an
   `AgentSession`;
5. chat creation succeeds with an empty temporary `PI_CODING_AGENT_DIR`;
6. project and project-session creation also succeed with no credentials;
7. a no-model prompt returns `409 model_required`, does not append a user
   record, and preserves the browser draft; and
8. existing mock lifecycle/SSE tests still pass unchanged except where they
   intentionally assert new fields.

If environment mutation makes a real-supervisor test unsafe in Node's shared
test process, spawn a child Node process with temporary `PI_WEB_HOME` and
`PI_CODING_AGENT_DIR` rather than relying on the developer's home directory.

## Manual verification

```sh
PI_WEB_HOME="$(mktemp -d)" \
PI_CODING_AGENT_DIR="$(mktemp -d)" \
PI_WEB_MODE=real \
npm start
```

- Add Chat succeeds.
- Opening its transcript succeeds.
- A bang still works.
- Sending a prompt produces the actionable model error.
- No file under the developer's normal `~/.pi/agent` is read or changed.

## Definition of done

- The original reported error has a captured safe root cause or an explicit
  note explaining why it could not be reproduced.
- Session creation does not initialize model auth.
- All errors are structured.
- Existing transcript identity and bang persistence invariants remain intact.
- `mise check` passes.
- The senior reviewer approves detached-session persistence.

---

# WEB-202 — Effective model settings and an unclipped picker

## User story

As a user, I can distinguish my configured default from the model currently
usable by the server. I can select Automatic, see why an explicit default is
unavailable, and use the picker at any viewport size without clipping.

## Files

Expected changes:

- `server/config.js`
- `server/routes.js`
- `server/supervisor/real.js`
- `server/supervisor/mock.js`
- `public/js/api.js`
- `public/js/store.js`
- `public/js/thread.js`
- `public/js/panels.js`
- `public/app.css`
- `test/config.test.js`
- `test/server.test.js`
- `test/dom.test.js`
- `test/sdk-surface.test.js`

## Fixed model semantics

- `config.defaultModel === null` means **Automatic**.
- Automatic selects the first Pi-available model at attach time.
- An explicit `provider/modelId` is used only if it is currently available.
- An explicit but unavailable default remains visible as configured and is
  marked unavailable. It must not silently select another model.
- A detached session has `model: null`. The UI may preview the effective
  default, but it must not claim the session recorded that model.
- Per-session selection requires a concrete available model. Automatic is only
  a global-default choice in this ticket.
- Logging out does not silently rewrite `config.defaultModel`. WEB-203 will
  display the resulting unavailable state and offer Automatic or login.

**Senior checkpoint:** Approve these semantics before implementation. Changing
them after WEB-203 will complicate auth UI and tests.

## State contract

Extend `GET /api/state` without removing existing fields:

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-6",
  "effectiveDefaultModel": null,
  "defaultModelStatus": "unavailable",
  "models": [],
  "modelError": null
}
```

Allowed `defaultModelStatus` values:

| Value | Meaning |
|---|---|
| `automatic` | Config is `null`; effective model may or may not exist |
| `available` | Explicit configured model is available |
| `unavailable` | Explicit configured model is unknown or lacks usable auth |

Example Automatic state with one available model:

```json
{
  "defaultModel": null,
  "effectiveDefaultModel": "openai-codex/gpt-5.4",
  "defaultModelStatus": "automatic"
}
```

`modelError` is a safe runtime/configuration diagnostic. Do not include a
credential, URL query string, provider response body, or stack trace.

## Implementation tasks

### 1. Return configured and effective values separately

Replace the current behavior that returns the stale configured value when no
model is available.

Illustrative supervisor method:

```js
async modelState() {
  const configured = loadConfig().defaultModel ?? null;
  const models = await this.listModels();
  const explicit = configured && models.find(model => model.id === configured);
  return {
    configuredDefault: configured,
    effectiveDefault: configured
      ? (explicit?.id || null)
      : (models[0]?.id || null),
    status: configured
      ? (explicit ? "available" : "unavailable")
      : "automatic",
    models,
    error: this.modelError || null,
  };
}
```

Do not swallow all model errors with `safe(() => ..., [])`. Empty availability
and runtime failure are different states. Keep the model list empty on failure,
but expose a safe `modelError` and log the full error once server-side.

### 2. Apply the effective default on first attach

For a session with no recorded `model_change` entry:

- Automatic + available model: attach with the effective model.
- Explicit + available model: attach with that exact model.
- No effective model: attach with no model; WEB-201's prompt preflight returns
  `model_required`.

A session with a recorded model change follows Pi's existing restore behavior.
Do not overwrite it with the global default.

### 3. Validate settings updates

`POST /api/settings` keeps its existing partial-update behavior.

Set Automatic:

```json
{"defaultModel": null}
```

Set an exact default:

```json
{"defaultModel":"anthropic/claude-sonnet-4-6"}
```

An exact value must be in the current available list:

```json
HTTP/1.1 400 Bad Request
{"error":"model_unavailable"}
```

Return the new configured/effective/status fields after saving. Do not return
only the effective value as `defaultModel`.

### 4. Make `/api/models` diagnostic rather than ambiguous

Use:

```json
{
  "models": [
    {
      "id": "anthropic/claude-sonnet-4-6",
      "provider": "anthropic",
      "label": "Claude Sonnet 4.6"
    }
  ],
  "error": null
}
```

Keep provider/model references canonical. Do not key identity by display label.

### 5. Update browser state

Add:

```js
defaultModel: null,          // configured setting
effectiveDefaultModel: null, // currently usable default
defaultModelStatus: "automatic",
modelError: null,
providers: [],               // populated by WEB-203
```

When selecting an active detached session, display its recorded model if one
exists; otherwise display `effectiveDefaultModel` as a preview. Label this
“Automatic” in Settings and avoid persisting a session model until Pi does so.

### 6. Add the Automatic option

Only the Settings/default picker includes this option:

```html
<button class="model-option" data-model-automatic role="option">
  <span class="model-option-main">Automatic</span>
  <span class="model-option-meta">first available model</span>
</button>
```

Do not encode Automatic as the string `"null"`, `"default"`, or an empty model
ID. Call `api.settings(null)` and store JavaScript `null`.

For an unavailable configured model, render it above the available choices:

```text
Claude Sonnet 4.6
Unavailable — sign in to Anthropic or choose another model
```

### 7. Group models by provider

Sort groups by provider label, then model label. Preserve the current canonical
ID in `data-model`. A group example:

```html
<div class="model-group" role="group" aria-label="Anthropic">
  <div class="model-group-label">Anthropic</div>
  <!-- model-option buttons -->
</div>
```

If no models are available, show:

```text
No models available
Connect Anthropic or OpenAI in Settings.
```

WEB-203 turns provider names into login actions.

### 8. Render the popover outside clipping ancestors

The current `.model-popover` is absolutely positioned under
`.model-picker`. Move the open popover to `document.body` and position it from
the toggle's `getBoundingClientRect()`.

Important implementation details:

- use `position: fixed`;
- clamp left/right to 12 px inside the viewport;
- prefer above the composer toggle and below the Settings toggle;
- if the preferred side lacks room, flip sides;
- include `max-height` based on available viewport space;
- close on resize, scroll, Escape, selection, and outside pointer;
- consider both `this.contains(target)` and `popover.contains(target)` for
  outside-click handling;
- remove the portal in `disconnectedCallback()`; and
- return focus to the toggle on Escape.

Illustrative geometry helper:

```js
function anchoredPosition(anchor, popover, preferred = "above") {
  const gap = 8;
  const margin = 12;
  const a = anchor.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  const roomAbove = a.top - margin;
  const roomBelow = innerHeight - a.bottom - margin;
  const above = preferred === "above"
    ? roomAbove >= Math.min(p.height, 240) || roomAbove >= roomBelow
    : !(roomBelow >= Math.min(p.height, 240) || roomBelow >= roomAbove);
  return {
    left: Math.max(margin, Math.min(a.right - p.width, innerWidth - p.width - margin)),
    top: above ? Math.max(margin, a.top - p.height - gap) : a.bottom + gap,
    maxHeight: Math.max(120, (above ? roomAbove : roomBelow) - gap),
  };
}
```

The exact arithmetic may differ, but the acceptance criteria may not.

### 9. Complete keyboard behavior

While open:

- ArrowDown/ArrowUp move among enabled options;
- Home/End go to first/last;
- Enter/Space selects;
- Escape closes and returns focus; and
- Tab follows normal browser order and then closes when focus leaves the
  picker/popover.

Use `aria-expanded`, `aria-controls`, `role=listbox`, `role=option`, and
`aria-selected` consistently.

## Tests

Add coverage for:

1. Automatic with zero and multiple available models;
2. explicit available and explicit unavailable defaults;
3. exact settings update validation and clearing to `null`;
4. explicit unavailable does not silently fall back;
5. model runtime failure is distinguishable from ordinary empty availability;
6. detached session state uses the effective preview without recording a model;
7. Automatic is present only in the default picker;
8. provider groups render in stable order;
9. portal creation/removal and outside-click handling;
10. Escape returns focus;
11. keyboard navigation; and
12. SDK surface checks include `ModelRuntime.getError`, `getAvailable`, and
    `getModel`.

jsdom does not calculate layout. Unit-test the geometry helper with explicit
rectangle inputs, and retain a real-browser visual check for clipping.

## Manual verification

At desktop and mobile widths:

- open the composer picker near every viewport edge;
- open the Settings picker;
- scroll while it is open;
- use only the keyboard;
- confirm no ancestor clips the list; and
- confirm an empty list points to Settings rather than showing a dead box.

## Definition of done

- Configured and effective defaults are never conflated.
- No silent fallback occurs for an explicit unavailable default.
- Automatic persists as JSON `null`.
- The popover remains within the viewport and is keyboard accessible.
- `mise check` passes.
- The senior reviewer approves default semantics.

---

# WEB-203 — Pi model-provider status and authentication

## User story

As a user, I can see whether Anthropic, OpenAI ChatGPT/Codex, and OpenAI API
access are configured. I can complete the supported Pi login flow from the web
UI and see models immediately afterward without ever exposing credentials to
the browser.

## Supported provider cards

| UI label | Pi provider ID | Methods |
|---|---|---|
| Anthropic | `anthropic` | Claude Pro/Max OAuth; API key |
| OpenAI — ChatGPT | `openai-codex` | ChatGPT Plus/Pro OAuth |
| OpenAI — API | `openai` | API key |

Do not label `openai` API-key authentication as OAuth. Do not refer to any AI
credential as an SSH token.

## Headless OAuth expectations

- OpenAI Codex device code is the recommended k3s flow.
- OpenAI browser callback is useful only when the browser and server share the
  expected localhost callback environment.
- Anthropic's Pi SDK flow starts a localhost callback and also accepts a manual
  code/redirect URL. In k3s, the user should expect the localhost navigation to
  fail and then paste the final address-bar URL into pi-ez-web.
- A normal externally hosted OAuth callback is not part of this ticket because
  the provider SDK uses fixed registered redirect behavior.

The UI must explain these constraints before the user starts a flow.

## Files

Expected changes:

- new `server/auth-flows.js`
- `server/supervisor/real.js`
- `server/supervisor/mock.js`
- `server/routes.js`
- `public/js/api.js`
- `public/js/store.js`
- `public/js/panels.js`
- `public/app.css`
- new `test/auth-flows.test.js`
- `test/server.test.js`
- `test/dom.test.js`
- `test/sdk-surface.test.js`

## Provider status contract

```http
GET /api/providers
```

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "configured": true,
      "source": "stored",
      "sourceLabel": "OAuth",
      "authMethods": [
        {
          "id": "oauth",
          "label": "Anthropic (Claude Pro/Max)",
          "subscription": true
        },
        {
          "id": "api_key",
          "label": "Anthropic API key",
          "subscription": false
        }
      ],
      "availableModels": 6,
      "canLogout": true,
      "error": null
    }
  ]
}
```

Allowed credential sources shown to the browser are sanitized categories such
as `stored`, `environment`, `runtime`, and `models_json`. Do not return an
environment variable's value, API-key suffix, token expiry payload, account
email, or raw credential metadata.

`canLogout` is false when authentication is ambient/environment-only. Logout
removes stored credentials; it cannot remove a Kubernetes environment value.

## Auth flow API

### Start

```http
POST /api/providers/openai-codex/login
content-type: application/json

{"type":"oauth"}
```

```json
HTTP/1.1 202 Accepted
{
  "flow": {
    "id": "f_8dcbe07a",
    "providerId": "openai-codex",
    "state": "pending"
  }
}
```

### Poll

```http
GET /api/auth-flows/f_8dcbe07a
```

A selection prompt:

```json
{
  "flow": {
    "id": "f_8dcbe07a",
    "providerId": "openai-codex",
    "state": "waiting_input",
    "prompt": {
      "id": "p_1",
      "type": "select",
      "message": "Select OpenAI Codex login method:",
      "options": [
        {"id":"browser","label":"Browser login"},
        {"id":"device_code","label":"Device code login (recommended for k3s)"}
      ]
    }
  }
}
```

A device-code notification:

```json
{
  "flow": {
    "id": "f_8dcbe07a",
    "providerId": "openai-codex",
    "state": "waiting_user",
    "notification": {
      "type": "device_code",
      "userCode": "ABCD-EFGH",
      "verificationUri": "https://auth.openai.com/codex/device",
      "expiresInSeconds": 900
    }
  }
}
```

Terminal state:

```json
{
  "flow": {
    "id": "f_8dcbe07a",
    "providerId": "openai-codex",
    "state": "complete"
  }
}
```

Allowed states:

- `pending`
- `waiting_input`
- `waiting_user`
- `complete`
- `error`
- `cancelled`

### Submit a prompt

```http
POST /api/auth-flows/f_8dcbe07a/input
content-type: application/json

{"promptId":"p_1","value":"device_code"}
```

Return `202` and the updated safe flow view. For `secret` prompts, the submitted
value must not be retained after resolving the pending promise.

### Cancel

```http
DELETE /api/auth-flows/f_8dcbe07a
```

Cancellation aborts SDK network activity and any pending prompt.

### Logout

```http
POST /api/providers/anthropic/logout
```

Return `409 credential_managed_by_environment` if deleting a stored credential
would not change effective environment-backed authentication.

## Implementation tasks

### 1. Add thin supervisor methods around the shared ModelRuntime

The real supervisor already owns one shared runtime. Add methods rather than
creating a second runtime with a different credential cache.

Illustrative methods:

```js
async listProviders() {
  const runtime = await this._modelRuntime();
  const allow = new Set(["anthropic", "openai-codex", "openai"]);
  const available = await runtime.getAvailable().catch(() => []);
  return runtime.getProviders()
    .filter(provider => allow.has(provider.id))
    .map(provider => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const methods = [];
      if (provider.auth.oauth) methods.push({
        id: "oauth",
        label: provider.auth.oauth.name,
        subscription: !!provider.auth.oauth.isSubscription,
      });
      if (provider.auth.apiKey?.login) methods.push({
        id: "api_key",
        label: provider.auth.apiKey.name,
        subscription: false,
      });
      return sanitizeProviderStatus(provider, status, methods, available);
    });
}

async loginProvider(providerId, type, interaction) {
  const runtime = await this._modelRuntime();
  await runtime.login(providerId, type, interaction);
  await runtime.refresh({ providers: [providerId], allowNetwork: true });
  await runtime.getAvailable(providerId);
  this.models = null;
}

async logoutProvider(providerId) {
  const runtime = await this._modelRuntime();
  await runtime.logout(providerId);
  this.models = null;
}
```

The final implementation must inspect refresh errors and preserve a safe
provider error instead of silently ignoring them. Never return the credential
from `runtime.login()`.

Mock mode should return a configured, non-login `mock` provider or an empty
managed-provider list, whichever makes the Settings UI clearest. It must not
pretend a real OAuth flow succeeded.

### 2. Implement an in-memory interaction bridge

`ModelRuntime.login()` expects:

```js
{
  signal,
  prompt: async prompt => "user response",
  notify: event => {},
}
```

Implement one flow object per active login. The flow:

- owns an `AbortController`;
- stores only sanitized prompts/notifications;
- exposes a promise for the current prompt;
- rejects stale `promptId` submissions;
- clears submitted secret values immediately;
- allows only one active AI login flow globally, avoiding collisions on the
  providers' fixed localhost callback ports;
- aborts after 20 minutes with a per-flow timer, not a background sweeper;
- removes terminal flows after the client observes them or after a short
  terminal retention timer; and
- treats process restart as cancellation. Completed credentials remain in
  Pi's durable `auth.json`.

Illustrative core shape:

```js
class AuthFlow {
  constructor(providerId, authType) {
    this.id = `f_${randomUUID()}`;
    this.providerId = providerId;
    this.authType = authType;
    this.state = "pending";
    this.controller = new AbortController();
  }

  interaction() {
    return {
      signal: this.controller.signal,
      notify: event => this.onNotification(event),
      prompt: prompt => this.waitForInput(prompt),
    };
  }

  waitForInput(prompt) {
    const promptId = `p_${++this.promptSequence}`;
    this.publicPrompt = sanitizePrompt(promptId, prompt);
    this.state = "waiting_input";
    return new Promise((resolve, reject) => {
      this.pendingInput = { promptId, resolve, reject };
      this.bindPromptAbort(prompt.signal, reject);
    });
  }

  submit(promptId, value) {
    if (this.pendingInput?.promptId !== promptId) {
      throw Object.assign(new Error("stale_auth_prompt"), {
        code: "stale_auth_prompt",
      });
    }
    const { resolve } = this.pendingInput;
    this.pendingInput = null;
    this.publicPrompt = null;
    this.state = "pending";
    resolve(String(value));
  }
}
```

Do not serialize the `AuthFlow` instance directly. Implement `publicView()`
that creates an allowlisted response object.

### 3. Sanitize auth errors

Provider errors may contain URLs or HTTP response bodies. The browser receives
an authored summary such as:

```json
{
  "state":"error",
  "error":{
    "code":"provider_login_failed",
    "message":"Anthropic login did not complete. Try again."
  }
}
```

The server log may include a redacted technical error and request/flow ID. Add
a redaction helper for obvious bearer tokens, `sk-...` values, URL query
strings, and OAuth `code` parameters. Do not assume redaction makes arbitrary
provider bodies safe enough to send to the browser.

### 4. Build provider cards and one auth-flow dialog

Replace the current Settings “Agent endpoint” and “Mode” rows with provider
cards. Each card displays:

- provider and auth-method label;
- Connected / Not connected / Environment / Error;
- count of currently available models;
- Login or Add API key;
- Logout only when meaningful; and
- a safe provider diagnostic.

The flow dialog must support:

- text input;
- secret input;
- select options;
- manual code/redirect URL;
- clickable auth URL;
- copyable device code and verification URL;
- progress text;
- cancel; and
- terminal success/error.

Poll no faster than once per second. Stop polling on terminal state or when the
component disconnects. Refresh `/api/state` and `/api/providers` after success
or logout so models appear immediately.

### 5. Protect secrets in browser code

- Do not place secret prompt values in `store.state`.
- Read a secret input only when submitting, then clear the element.
- Do not include secret values in thrown browser errors.
- Do not persist auth flow data in localStorage/sessionStorage.
- Do not add auth notifications to transcript SSE.

## Tests

Use a fake model runtime; do not call provider networks.

Required cases:

1. provider status exposes methods but not credentials;
2. auth URL notification;
3. device code notification;
4. select prompt and valid submission;
5. secret prompt value is absent from `publicView()` before and after submit;
6. stale prompt ID returns `409 stale_auth_prompt`;
7. cancellation aborts SDK work and rejects pending input;
8. timeout transitions to error/cancelled;
9. starting any second AI login flow returns `409 auth_flow_active`;
10. successful login refreshes available models;
11. logout updates status;
12. environment-backed auth cannot misleadingly claim to be removed;
13. provider/runtime errors are sanitized;
14. browser polling stops and clears secret inputs; and
15. SDK surface assertions include `checkAuth`, `getProviderAuthStatus`,
    `login`, `logout`, and `refresh`.

## Manual verification

Run these only with explicit credentials/accounts; they are not part of
`mise check`:

1. OpenAI Codex device login and logout.
2. Anthropic OAuth manual redirect paste and logout.
3. Anthropic API-key login, then verify the key never appears in browser
   network responses or server logs.
4. OpenAI API-key login.
5. Restart the single pod/process and confirm completed credentials persist.
6. Cancel each flow midway and verify it leaves no connected state.

## Security review checklist — required

- [ ] Browser never receives a credential object.
- [ ] Secret input is not retained in a flow, store, error, or log.
- [ ] Unknown providers and unsupported auth types are rejected.
- [ ] Only one AI login flow can be active, preventing fixed callback-port
      collisions.
- [ ] Flow IDs are unguessable and expire.
- [ ] Logout semantics are truthful for environment credentials.
- [ ] Pi writes to the expected `PI_CODING_AGENT_DIR/auth.json` mount.
- [ ] Auth routes remain inside the existing trusted-tailnet deployment.

## Definition of done

- All three provider cards report truthful status.
- Supported login/logout flows work without exposing credentials.
- Models refresh immediately after auth changes.
- Credential-free tests pass.
- `mise check` passes.
- A senior completes the security review checklist.

---

# WEB-204 — Local, GitHub, and Git URL repository sources

## User story

As a user, I can choose Local, GitHub, or Git URL when adding a project. I can
sign in to GitHub with a device code, see private repositories I can access,
and safely clone one into the configured repository root.

## Product behavior

The source selector labels are exactly:

- **Local** — scan `reposRoot` or connect an absolute path;
- **GitHub** — list repositories available to the connected account and clone
  over authenticated HTTPS; and
- **Git URL** — clone a public `https://` repository URL.

Do not use the ambiguous label “Remote”. Do not expose SSH controls in this
epic.

## Files

Expected changes:

- `server/config.js`
- new `server/github.js`
- new `server/repositories.js`
- `server/routes.js`
- `server/workspaces.js` only if shared Git helpers belong there
- `public/js/api.js`
- `public/js/store.js`
- `public/js/panels.js`
- `public/app.css`
- `Dockerfile`
- new `test/github.test.js`
- new `test/repositories.test.js`
- `test/config.test.js`
- `test/server.test.js`
- `test/dom.test.js`

## Configuration schema

Add this non-secret section:

```json
{
  "repositorySources": {
    "default": "github",
    "github": {
      "clientId": "Iv1.non-secret-oauth-client-id",
      "owner": "bry-guy"
    }
  }
}
```

Defaults:

```js
repositorySources: {
  default: "local",
  github: {
    clientId: null,
    owner: null,
  },
}
```

Allowed default values are `local`, `github`, and `git-url`. Invalid values
fall back to `local` and produce a safe Settings warning; do not crash startup.

The GitHub OAuth App must have Device Flow enabled. The client ID is not a
secret. No client secret is needed for the basic device flow described here.
The operator must provide the OAuth App/client ID before real GitHub login can
be accepted.

## Environment overrides

| Effective setting | Environment override | Config fallback | Editable in UI when overridden? |
|---|---|---|---|
| Repository root | `PI_WEB_REPOS_ROOT` | `reposRoot` | No |
| Default source | `PI_WEB_REPOSITORY_SOURCE` | `repositorySources.default` | No |
| GitHub client ID | `PI_WEB_GITHUB_CLIENT_ID` | `repositorySources.github.clientId` | No |
| GitHub owner filter | `PI_WEB_GITHUB_OWNER` | `repositorySources.github.owner` | No |
| GitHub credential | `PI_WEB_GITHUB_TOKEN` | `github-auth.json` | Logout disabled for environment value |

Validate environment values with the same rules as config values. An
environment-controlled field should display its source and be disabled, not
accept a misleading save.

`PI_WEB_URL` is not a runtime setting. It remains a client-side base override
for existing mise helper/verification tasks unless a later feature explicitly
uses it.

## GitHub credential storage

Path:

```text
$PI_WEB_HOME/github-auth.json
```

Minimum shape:

```json
{
  "version": 1,
  "accessToken": "REDACTED",
  "tokenType": "bearer",
  "scope": "repo,read:user",
  "account": {
    "id": 1234,
    "login": "bry-guy"
  }
}
```

The API must never return `accessToken`. Store the file with mode `0600` and
its parent directory without group/world write permission where the filesystem
supports POSIX modes. Write through a temporary file in the same directory and
rename atomically.

If GitHub returns expiring/refresh-token fields, preserve them in the private
store but do not implement a refresh protocol without confirming GitHub's
client-secret requirements. A `401` from an expired token should mark the
connection invalid and ask the user to log in again.

Illustrative atomic writer:

```js
function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
```

Do not reuse `config.json` for this value.

## GitHub device-flow API

### Start login

```http
POST /api/github/device-login
```

Server-side request:

```http
POST https://github.com/login/device/code
accept: application/json
content-type: application/x-www-form-urlencoded

client_id=...&scope=repo+read%3Auser
```

Browser response:

```json
HTTP/1.1 202 Accepted
{
  "flow": {
    "id": "ghf_b764...",
    "state": "waiting_user",
    "userCode": "ABCD-EFGH",
    "verificationUri": "https://github.com/login/device",
    "expiresAt": "2026-08-08T23:12:00.000Z",
    "intervalSeconds": 5
  }
}
```

### Poll local flow status

```http
GET /api/github/device-login/ghf_b764
```

The server polls GitHub's token endpoint at GitHub's interval. Handle
`authorization_pending`, `slow_down`, `expired_token`, and `access_denied`
without busy-looping. The browser polls only pi-ez-web and never receives the
GitHub `device_code` or access token.

Terminal success:

```json
{
  "flow": {
    "id": "ghf_b764...",
    "state": "complete",
    "account": {"login":"bry-guy"}
  }
}
```

### Cancel and logout

```http
DELETE /api/github/device-login/ghf_b764
POST /api/github/logout
```

Logout deletes `github-auth.json`. If `PI_WEB_GITHUB_TOKEN` is effective,
return `409 credential_managed_by_environment`.

Use an injectable `fetch`, clock, and sleep function in `server/github.js` so
all device-flow tests are local and deterministic.

## Repository-source status API

```http
GET /api/repository-sources
```

```json
{
  "default": "github",
  "reposRoot": "/data/pi-ez-workspaces",
  "reposRootSource": "environment",
  "sources": [
    {"id":"local","enabled":true},
    {
      "id":"github",
      "enabled":true,
      "configured":true,
      "authenticated":true,
      "credentialSource":"stored",
      "account":{"login":"bry-guy"},
      "owner":"bry-guy"
    },
    {"id":"git-url","enabled":true}
  ]
}
```

`configured` means a client ID is present. `authenticated` means an effective
token is present; it does not promise every organization has authorized the
OAuth app.

## GitHub repository list API

```http
GET /api/github/repos?q=infra&page=1
```

```json
{
  "repos": [
    {
      "id": 123456,
      "name": "infra",
      "fullName": "bry-guy/infra",
      "owner": "bry-guy",
      "private": true,
      "updatedAt": "2026-08-08T20:00:00Z"
    }
  ],
  "nextPage": null
}
```

Implementation requirements:

- request `GET https://api.github.com/user/repos` with `per_page=100`;
- include owner, collaborator, and organization-member affiliations;
- paginate from GitHub's `Link` response rather than guessing;
- apply the configured owner filter server-side;
- search case-insensitively over `name` and `full_name`;
- send `Authorization: Bearer`, `Accept`, `User-Agent`, and the current stable
  GitHub API-version header;
- never return `clone_url` containing credentials; preferably do not return a
  clone URL at all; and
- map `401` to `github_auth_required`, `403` to a safe rate-limit/SSO message,
  and other upstream failures to `github_unavailable`.

Some private organization repositories require the user to authorize the OAuth
token for SAML SSO. Document that GitHub may require this after login.

## Project creation contract

Extend the existing endpoint with a discriminated request while retaining the
old local shape for compatibility.

Local:

```json
{"source":"local","repoPath":"/data/pi-ez-workspaces/pi-ez-web"}
```

GitHub:

```json
{"source":"github","fullName":"bry-guy/private-repo"}
```

Public Git URL:

```json
{"source":"git-url","url":"https://example.com/owner/repository.git"}
```

Successful clone and connection:

```json
{
  "id": "p_abcd",
  "sessionId": "session-id",
  "repoPath": "/data/pi-ez-workspaces/private-repo",
  "cloned": true
}
```

Refactor the existing connect logic into one function so local and cloned
repositories receive exactly the same project/session behavior.

## Clone safety requirements

### URL validation

For `git-url`:

```js
function parsePublicGitUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); }
  catch { throw coded("invalid_git_url"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw coded("invalid_git_url");
  }
  url.hash = "";
  return url.toString();
}
```

Reject `file:`, `git:`, `ssh:`, `ext:`, SCP-like syntax, embedded
user/password values, and local filesystem paths. This is not intended to be a
full untrusted-network sandbox; the whole app remains a trusted-operator tool.

For GitHub, do not trust a clone URL supplied by the browser. Fetch repository
metadata for the selected `fullName` with the effective token and use GitHub's
HTTPS `clone_url`.

### Destination

- derive the directory from GitHub's repository `name` or a validated URL
  basename;
- allow only a single safe path segment after removing `.git`;
- resolve it under the effective `reposRoot` and verify it cannot escape;
- return `409 repository_exists` with a safe `repoPath` if the destination
  exists;
- return `409 clone_in_progress` for a concurrent clone of the same
  destination; and
- never overwrite or delete an existing directory.

### Atomic clone

Clone into a unique temporary directory inside `reposRoot`, then rename it to
the final destination. Remove only the temporary directory after a failed or
cancelled clone. Do not delete a successfully cloned repository if later UI
navigation fails.

Use async `execFile`, never a shell string:

```js
const execFileAsync = promisify(execFile);

await execFileAsync("git", [
  "-c", "credential.helper=",
  "clone", "--", cloneUrl, temporaryPath,
], {
  env: gitEnvironment,
  signal,
  timeout: 10 * 60_000,
  maxBuffer: 2 * 1024 * 1024,
});
```

Do not use a shallow clone; project sessions and branches need normal Git
history unless a separate product decision changes that.

### GitHub `GIT_ASKPASS`

Create a mode-`0700` temporary script containing no token:

```sh
#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\n' 'x-access-token' ;;
  *[Pp]assword*) printf '%s\n' "$PI_WEB_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
```

Run Git with:

```js
const gitEnvironment = {
  ...process.env,
  GIT_ASKPASS: askpassPath,
  GIT_TERMINAL_PROMPT: "0",
  PI_WEB_GIT_TOKEN: token,
};
```

The token must not appear in `cloneUrl`, `args`, thrown safe errors, or logs.
Remove the helper after the child exits. Never log `gitEnvironment`.

### Clone failure response

```json
HTTP/1.1 502 Bad Gateway
{
  "error":"clone_failed",
  "message":"Git could not clone this repository.",
  "requestId":"..."
}
```

Log redacted stderr under the request ID. Git stderr can echo URLs, so strip URL
userinfo/query strings and token-like values before logging.

## Project-picker UI

Turn the current static `local ▾` span into a button/listbox. Keep source state
inside the picker and initialize it from the configured default.

### Local

Preserve:

- repository scan;
- text filtering;
- absolute and `~/...` path connection; and
- existing duplicate/not-a-repo messages.

### GitHub

States:

1. Missing client ID — explain operator configuration.
2. Not connected — “Connect GitHub” starts device flow.
3. Device flow — verification link, code, copy button, cancel.
4. Connected — account chip and searchable repository list.
5. Loading/cloning — disable source switching and selected row.
6. Clone failure — retain source/query and show safe retry.

Show `private`/`public`, owner, and update time. Do not expose token scopes or
raw API responses in the row.

### Git URL

Show one HTTPS URL input and Connect button. Preserve the entered URL after a
validation/clone error. Explain that private non-GitHub and SSH credentials are
not supported yet.

The clone request may remain one long-running HTTP request for this epic. The
server uses async `execFile` so other requests continue. Client disconnect may
abort the child process through the request signal where supported. Do not add
a durable clone-job queue.

## Docker image

The current slim Node image does not guarantee `git` is installed. Add the
minimum OS packages needed by existing workspace operations and HTTPS clones:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

Do not install `gh`. Do not install `openssh-client` while SSH clone is a
non-goal.

## Tests

### GitHub client/device flow

Using fake fetch and clock:

1. start response parsing;
2. required `repo read:user` scope;
3. authorization pending respects interval;
4. `slow_down` increases interval;
5. success stores token privately and returns only account metadata;
6. denied/expired/cancelled states;
7. no client ID;
8. environment-token precedence and non-logout behavior;
9. repository pagination, owner filter, and search;
10. `401`, `403`, rate limit, and SSO-safe errors; and
11. token never appears in serialized status/errors.

### Clone service

Inject `runGit` so tests can inspect calls without network access:

1. public HTTPS URL accepted;
2. invalid schemes, credentials, malformed URLs, and path escape rejected;
3. destination collision and concurrent clone rejected;
4. GitHub clone URL comes from server-side metadata;
5. token is absent from argv and URL but present only in child env;
6. credential helper is disabled and terminal prompting is off;
7. temporary directory is renamed on success;
8. temporary directory is removed on failure/cancel;
9. existing destination is never removed;
10. stderr is redacted; and
11. cloned repo passes the existing project connection path.

### Server/DOM

1. legacy `{repoPath}` local project request still works;
2. all three source tabs render and are keyboard reachable;
3. default source is selected;
4. environment-controlled Settings fields are disabled;
5. GitHub login and clone loading/error/success states; and
6. project appears in sidebar immediately after clone/connect.

No test may require a real GitHub client ID or token.

## Manual verification

With a deliberately configured test OAuth App/account:

- login via device flow;
- list a private personal repository;
- list an authorized private organization repository;
- clone it on the NFS-backed repository root;
- verify `origin` contains a normal credential-free HTTPS URL;
- inspect process arguments and logs for token leakage;
- restart the pod and confirm GitHub status persists;
- log out and confirm private listing fails cleanly;
- clone a public Git URL; and
- verify a destination collision leaves the existing checkout untouched.

## Security review checklist — required

- [ ] OAuth client ID is configurable and is treated as non-secret.
- [ ] Access token is only in the private store or explicit environment value.
- [ ] Device code and access token are not confused; browser never receives the
      access token.
- [ ] GitHub clone URL and argv are credential-free.
- [ ] `GIT_ASKPASS` script contains no token.
- [ ] Unknown URL schemes and embedded credentials are rejected.
- [ ] Destination cannot escape `reposRoot`.
- [ ] Existing directories are never overwritten or cleaned automatically.
- [ ] Temporary clone cleanup is bounded to the generated temporary path.
- [ ] Logs and API errors are redacted.

## Definition of done

- Local, GitHub, and Git URL flows work as specified.
- An authenticated private GitHub repository can be listed and cloned.
- No secret crosses the server/browser boundary or appears in Git argv/URL.
- The container contains `git` and CA certificates.
- `mise check` passes without network credentials.
- A senior completes the security review checklist.

---

# WEB-205 — Configuration hardening, documentation, and deployment acceptance

## User story

As an operator, I can tell which file/environment value controls every
setting, persist the right directories across a restart, and deploy one safe
pod without relying on undocumented behavior.

## Files

Expected changes:

- `server/config.js`
- `server/index.js` if startup diagnostics need adjustment
- `README.md`
- `docs/implementation.md`
- `docs/deployment.md`
- `Dockerfile` if WEB-204 did not already update it
- `test/config.test.js`
- `test/server.test.js`
- optional explicit smoke script under `scripts/` only if it stays
  credential-free by default

Site-specific Kubernetes YAML remains in `~/dev/infra`, not this repository.

## Configuration normalization

`loadConfig()` currently shallow-merges defaults. Add explicit nested
normalization so a partial `repositorySources.github` value cannot erase other
defaults.

Illustrative shape:

```js
export function loadConfig() {
  const raw = readJson(configPath(), {});
  return {
    ...DEFAULTS,
    ...raw,
    repositorySources: {
      ...DEFAULTS.repositorySources,
      ...(raw.repositorySources || {}),
      github: {
        ...DEFAULTS.repositorySources.github,
        ...(raw.repositorySources?.github || {}),
      },
    },
  };
}
```

Normalize/validate after merging:

- `projects` is an array;
- `defaultModel` is `null` or a non-empty string;
- repository source is one of the three allowed IDs;
- owner is `null` or a trimmed non-empty string;
- client ID is `null` or a trimmed non-empty string;
- repository/worktree roots resolve through existing path rules; and
- unknown keys survive a Settings round trip so forward-compatible manual
  configuration is not destroyed.

Invalid config should produce a safe warning and a default, not crash the
server. Invalid JSON should be surfaced clearly rather than silently treated as
an empty configuration. Preserve the last known file; never overwrite invalid
JSON merely because a Settings screen opened.

## Atomic application-state writes

Use same-directory temporary file + rename for:

- `config.json`;
- `bindings.json`;
- `closed.json`; and
- `github-auth.json`.

Keep each file's existing ownership. GitHub auth must be `0600`; other state
files may also use `0600`. A failed write returns a structured error and leaves
the previous file intact.

One replica avoids application-level concurrent writers, but an operator may
edit `config.json` manually. A Settings update should load the latest valid file
immediately before applying its partial patch.

## Effective-setting response

Settings should show value, source, and editability. Either add a nested
`settings` object to state or return equivalent fields from a dedicated
endpoint. Prefer one consistent representation:

```json
{
  "settings": {
    "reposRoot": {
      "value": "/data/pi-ez-workspaces",
      "source": "PI_WEB_REPOS_ROOT",
      "editable": false
    },
    "defaultRepositorySource": {
      "value": "github",
      "source": "config",
      "editable": true
    },
    "githubOwner": {
      "value": "bry-guy",
      "source": "PI_WEB_GITHUB_OWNER",
      "editable": false
    },
    "defaultModel": {
      "value": null,
      "source": "config",
      "editable": true
    }
  }
}
```

Retain old top-level fields during this epic if removing them would create
unnecessary client churn.

When a client attempts to update an environment-controlled field:

```json
HTTP/1.1 409 Conflict
{
  "error":"setting_overridden",
  "field":"reposRoot",
  "source":"PI_WEB_REPOS_ROOT"
}
```

Do not save a value that appears to succeed but has no runtime effect.

## Runtime environment contract

Document these exact meanings:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP listen port; overrides `config.port` |
| `PI_WEB_MODE` | `real` or `mock`; deployment uses `real` |
| `PI_WEB_HOME` | App config, bindings, closed markers, chats, and GitHub auth |
| `PI_CODING_AGENT_DIR` | Pi sessions, settings, models, and AI credentials |
| `PI_WEB_REPOS_ROOT` | Overrides configured local/clone repository root |
| `PI_WEB_REPOSITORY_SOURCE` | Overrides configured default project source |
| `PI_WEB_GITHUB_CLIENT_ID` | Overrides configured non-secret OAuth client ID |
| `PI_WEB_GITHUB_OWNER` | Overrides configured GitHub owner filter |
| `PI_WEB_GITHUB_TOKEN` | Secret environment credential; overrides stored GitHub auth |
| `PI_WEB_URL` | Not consumed by the runtime server; used by selected local helper tasks |

Do not claim a generic “all environment values override all config” rule for
fields that have no environment counterpart.

## Container storage contract

The target deployment supplied for this work uses stable paths such as:

```text
PI_WEB_HOME=/data/pi-ez-web
PI_CODING_AGENT_DIR=/data/pi-ez-agent
reposRoot=/data/pi-ez-workspaces
worktreeRoot=/data/pi-ez-worktrees
```

Persist all four locations or their common parent as appropriate. Keep mount
paths identical after restart because Git worktree metadata records absolute
paths.

Expected files include:

```text
/data/pi-ez-web/config.json
/data/pi-ez-web/bindings.json
/data/pi-ez-web/closed.json
/data/pi-ez-web/chats/
/data/pi-ez-web/github-auth.json
/data/pi-ez-agent/auth.json
/data/pi-ez-agent/models.json
/data/pi-ez-agent/settings.json
/data/pi-ez-agent/sessions/
```

Repositories and worktrees must also survive pod replacement.

Keep NFS unless verification demonstrates a concrete incompatibility. Validate:

- same-directory atomic rename;
- mode/ownership behavior for credential files;
- Git clone, branch, worktree add/remove, and prune;
- Pi auth file locking in the single process; and
- stable absolute mount paths.

Do not introduce a second local storage tier merely as a precaution. If NFS
fails an acceptance test, document the exact failure before redesigning
storage.

## Settings information architecture

The final Settings screen contains:

1. **AI providers** — cards from WEB-203.
2. **Default model** — Automatic or exact available model.
3. **Repository sources** — root, default source, GitHub client/account/owner.
4. **Diagnostics** — only actionable safe errors and environment-source notes.

Remove the current Agent endpoint and Mode rows. Runtime mode may remain in a
small diagnostics footer only if it helps mock development; it is not an
editable production setting.

## Documentation updates

### `README.md`

- explain the three repository sources;
- distinguish OpenAI Codex OAuth from OpenAI API keys;
- explain Anthropic's remote manual-code behavior;
- include the new config shape;
- list environment overrides;
- state where credentials are stored; and
- preserve the trusted-tailnet warning.

### `docs/implementation.md`

- update layout for new auth/repository modules;
- record detached-session behavior;
- record configured/effective model semantics;
- document auth-flow polling and one-replica limitation;
- document secure clone behavior and non-goals; and
- keep transcript/SSE invariants unchanged.

### `docs/deployment.md`

- list exact persistent paths;
- state that the image includes `git` and CA certificates;
- show one replica only;
- document NFS acceptance requirements;
- explain credential permissions and backup sensitivity;
- keep Tailscale/Caddy and site-specific manifests in `~/dev/infra`; and
- state that SSE proxying must remain enabled.

Archive this plan after the implementation is complete and
`docs/implementation.md` reflects reality.

## Automated tests

1. nested config defaults and partial overrides;
2. invalid source/model/owner/client values;
3. invalid JSON is surfaced and not overwritten;
4. environment precedence for every documented override;
5. environment-controlled update returns `409 setting_overridden`;
6. atomic write leaves old file on simulated failure;
7. credential file mode where POSIX permissions are available;
8. unknown config keys survive Settings update;
9. state exposes source/editability consistently; and
10. README/deployment DOM or text gates are updated only where existing tests
    intentionally assert documentation/UI text.

## Final acceptance run

### Credential-free gate

```sh
mise check
```

Must remain fully offline except package installation already completed.

### Container gate

When Docker is available:

```sh
docker build -t pi-ez-web:acceptance .
docker run --rm \
  -p 3141:3141 \
  -e PI_WEB_MODE=mock \
  -e PI_WEB_HOME=/data/pi-ez-web \
  -v "$PWD/.mise/state/container:/data" \
  pi-ez-web:acceptance
```

Verify the image starts and can run Git operations as the unprivileged `node`
user. Adjust the host volume permissions deliberately; do not run the
application container as root merely to bypass ownership.

### Explicit real-provider gate

Not part of `mise check`:

- create/open a chat with no credentials;
- OpenAI Codex device login and one prompt;
- Anthropic login (manual redirect paste) and one prompt;
- provider logout/re-login;
- GitHub device login;
- private repository listing and clone;
- project session, branch worktree, and restart persistence;
- inspect browser responses, logs, Git origin, and process args for secrets;
- restart the pod and re-check status; and
- verify Caddy preserves SSE.

Record blockers separately. Do not weaken credential-free tests because an
external OAuth provider or browser binary is unavailable.

## Deployment review checklist

- [ ] Exactly one replica.
- [ ] Stable writable mounts for app, Pi, repos, and worktrees.
- [ ] Pod UID/GID can write NFS paths without running as root.
- [ ] `github-auth.json` and Pi `auth.json` are treated as secrets in backups.
- [ ] No secret appears in ConfigMap/config JSON committed to infrastructure.
- [ ] Caddy/Tailscale restrict access and preserve SSE.
- [ ] Git and CA certificates exist in the image.
- [ ] Environment-overridden fields are visibly read-only.
- [ ] Site-specific YAML remains outside this repository.

## Definition of done

- Actual behavior and all documentation agree.
- Config writes are atomic and precedence is tested.
- The image passes its available container smoke check.
- NFS behavior is measured rather than assumed.
- Credential-free and explicit real-provider gates remain separate.
- `mise check` passes.
- The deployment reviewer signs off.

---

# Epic completion checklist

- [ ] WEB-201 merged and root-cause evidence recorded.
- [ ] WEB-202 merged with approved default semantics.
- [ ] WEB-203 merged with AI credential security review.
- [ ] WEB-204 merged with GitHub/clone security review.
- [ ] WEB-205 merged with updated runtime/deployment docs.
- [ ] No new npm runtime dependency.
- [ ] No change to transcript SSE contract v1.
- [ ] No automatic chat scratch cleanup.
- [ ] No secret in API responses, browser state, config, Git URL/argv, or logs.
- [ ] `mise check` passes at the final commit.
- [ ] Remaining real-OAuth, Docker, or browser-environment blockers are recorded
      explicitly rather than hidden by mocks.
