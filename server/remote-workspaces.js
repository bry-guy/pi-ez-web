// Client for workspaced. Projects live in per-project workers; web routes
// project/session calls to the owning worker, merges their state into
// /api/state, and re-emits their events on its own SSE hub. Without
// PI_WEB_WORKSPACED_URL none of this is active and projects stay in-process.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Workers read web's model logins from a read-only copy. Pi refreshes OAuth
// itself only inside 5 minutes of expiry (and would fail on the read-only
// file), so web refreshes at 30 minutes and republishes well before that.
const MODEL_AUTH_MIN_VALIDITY_MS = 30 * 60_000;
const MODEL_AUTH_SYNC_MS = 5 * 60_000;

const DROP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"];

export function remoteWorkspacesFromEnv(env, deps) {
  const url = env.PI_WEB_WORKSPACED_URL;
  if (!url) return null;
  const modelAuthPath = path.join(env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "auth.json");
  return createRemoteWorkspaces({ url: url.replace(/\/+$/, ""), token: env.WORKSPACED_TOKEN || null, modelAuthPath, ...deps });
}

export function createRemoteWorkspaces({ url, token, hub, github, sup = null, modelAuthPath = null, fetchImpl = globalThis.fetch, readyTimeoutMs = 180_000, retryMs = 5_000, modelAuthSyncMs = MODEL_AUTH_SYNC_MS }) {
  const owners = { project: new Map(), session: new Map() };
  const streams = new Map();
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  let stopped = false;

  const call = (path, init = {}) => fetchImpl(`${url}/v1${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const workerPath = (name, rest) => `/workspaces/${encodeURIComponent(name)}/api${rest}`;

  async function list() {
    const res = await call("/workspaces");
    if (!res.ok) throw Object.assign(new Error("workspaced unavailable"), { code: "workspaced_unavailable" });
    return (await res.json()).workspaces || [];
  }

  async function workerState(name) {
    const res = await call(workerPath(name, "/state"));
    return res.ok ? res.json() : null;
  }

  function remember(name, projects) {
    for (const p of projects) {
      owners.project.set(p.id, name);
      for (const s of p.sessions || []) owners.session.set(s.id, name);
    }
  }

  // Remote projects for /api/state; also refreshes ownership and event streams.
  async function projects() {
    let workspaces;
    try { workspaces = await list(); } catch { return []; }
    const out = [];
    const pending = w => ({ id: `workspace:${w.name}`, name: w.name, workspace: w.name, pending: true, branches: [], sessions: [], contexts: [], worktrees: {}, workspaceStatus: {} });
    const lists = await Promise.all(workspaces.map(async w => {
      if (!w.ready) return [pending(w)];
      subscribe(w.name);
      const state = await workerState(w.name).catch(() => null);
      if (!state) return [];
      remember(w.name, state.projects || []);
      return (state.projects || []).map(p => ({ ...p, workspace: w.name }));
    }));
    out.push(...lists.flat());
    return out;
  }

  async function owner(kind, id) {
    if (!owners[kind].has(id)) await projects();
    return owners[kind].get(id) || null;
  }

  async function forward(c, name) {
    const raw = c.req.url;
    const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const rest = c.req.path.replace(/^.*?\/api(?=\/)/, "");
    const headers = new Headers(c.req.raw.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    headers.delete("authorization");
    if (auth.authorization) headers.set("authorization", auth.authorization);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let res;
    try {
      res = await fetchImpl(`${url}/v1${workerPath(name, rest)}${search}`, { method: c.req.method, headers, body: hasBody ? c.req.raw.body : undefined, duplex: "half", signal: c.req.raw.signal });
    } catch {
      return c.json({ error: "workspace_unavailable", workspace: name }, 502);
    }
    const out = new Headers(res.headers);
    for (const h of DROP_HEADERS) out.delete(h);
    return new Response(res.body, { status: res.status, headers: out });
  }

  // Fan-in: each worker numbers its own events, so re-emit through web's hub
  // to keep one ordered sequence for the browser.
  function subscribe(name) {
    if (streams.has(name) || stopped) return;
    const controller = new AbortController();
    streams.set(name, controller);
    (async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const res = await call(workerPath(name, "/events"), { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
              if (!data) continue;
              try {
                const { v: _v, seq: _seq, sessionId, type, ...rest } = JSON.parse(data);
                if (sessionId) owners.session.set(sessionId, name);
                hub.emit(sessionId, type, rest);
              } catch { /* malformed frame */ }
            }
          }
        } catch { /* reconnect below */ }
        if (!stopped && !controller.signal.aborted) await new Promise(r => setTimeout(r, retryMs));
      }
    })();
  }

  async function waitReady(name) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const res = await call(workerPath(name, "/health")).catch(() => null);
      if (res?.ok) return;
      await new Promise(r => setTimeout(r, 2_000));
    }
    throw Object.assign(new Error("workspace did not become ready"), { code: "workspace_start_timeout" });
  }

  async function pushGitHubAuth() {
    const value = github?.effectiveAuth?.();
    const body = value ? { version: 1, accessToken: value.accessToken, tokenType: value.tokenType || "bearer", scope: value.scope || "", account: value.account || null } : {};
    const res = await call("/github-auth", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw Object.assign(new Error("could not share GitHub login"), { code: "workspaced_unavailable" });
  }

  let publishedModelAuth = null;
  async function pushModelAuth() {
    const runtime = await sup?._modelRuntime?.().catch(() => null);
    if (runtime) {
      for (const { providerId, type } of await runtime.listCredentials()) {
        if (type === "oauth") await runtime.getAuth(providerId, { minOAuthValidityMs: MODEL_AUTH_MIN_VALIDITY_MS }).catch(() => {});
      }
    }
    let content;
    try { content = modelAuthPath ? readFileSync(modelAuthPath, "utf8") : "{}"; } catch { content = "{}"; }
    if (content === publishedModelAuth) return;
    const res = await call("/model-auth", { method: "PUT", headers: { "content-type": "application/json" }, body: content });
    if (!res.ok) throw Object.assign(new Error("could not share model logins"), { code: "workspaced_unavailable" });
    publishedModelAuth = content;
  }
  const modelAuthTimer = modelAuthSyncMs ? setInterval(() => pushModelAuth().catch(() => {}), modelAuthSyncMs) : null;
  modelAuthTimer?.unref?.();
  if (modelAuthTimer) pushModelAuth().catch(() => {});

  // Adding a repository creates its workspace, then the worker connects it.
  async function createProject(c, body) {
    const repository = body.source === "github" ? body.fullName : body.url;
    if (typeof repository !== "string" || !repository.trim()) return c.json({ error: "invalid_repository" }, 400);
    await pushGitHubAuth();
    await pushModelAuth();
    const res = await call("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: repository.trim(), containers: !!body.containers }) });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) return c.json({ error: created.error || "workspaced_unavailable" }, res.status);
    await waitReady(created.name);
    subscribe(created.name);
    const forwarded = await call(workerPath(created.name, "/projects"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await forwarded.json().catch(() => ({}));
    if (forwarded.ok) { owners.project.set(result.id, created.name); if (result.sessionId) owners.session.set(result.sessionId, created.name); }
    return c.json({ ...result, workspace: created.name }, forwarded.status);
  }

  return {
    projects, owner, forward, createProject, pushGitHubAuth, pushModelAuth,
    stop() { stopped = true; clearInterval(modelAuthTimer); for (const c of streams.values()) c.abort(); },
  };
}

// Mount before the in-process routes so remote ids never reach them.
export function registerRemoteRoutes(api, remote) {
  for (const [kind, pattern] of [["project", "/projects/:id/*"], ["session", "/sessions/:id/*"]]) {
    api.use(pattern, async (c, next) => {
      const name = await remote.owner(kind, c.req.param("id"));
      return name ? remote.forward(c, name) : next();
    });
  }
  api.post("/projects", async (c, next) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.source !== "github" && body.source !== "git-url") return next();
    return remote.createProject(c, body);
  });
}
