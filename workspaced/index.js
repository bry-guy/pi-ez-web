import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLifecycle, PASSIVE } from "./lifecycle.js";
import { slugFromRepository, validName } from "./manifests.js";

// Hop-by-hop and length/encoding headers; fetch() re-frames bodies itself.
const DROP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding", "authorization"];
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;

function tokenMatches(header, token) {
  const given = Buffer.from(String(header || "").replace(/^Bearer /, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// workspaced: creates/removes per-project workspaces, holds grants, and routes
// web's session traffic to each workspace's worker. Only web calls it.
// auth "network" means a NetworkPolicy admits only web; otherwise a bearer token.
export function createWorkspaced({ provider, token, auth = "token", fetchImpl = globalThis.fetch, lifecycle = createLifecycle({ provider, fetchImpl, idleMs: 0 }) }) {
  if (auth !== "network" && !token) throw new Error("WORKSPACED_TOKEN is required unless WORKSPACED_AUTH=network");
  const app = new Hono();
  const named = handler => async c => {
    const name = c.req.param("name");
    return validName(name) ? handler(c, name) : c.json({ error: "invalid_name" }, 400);
  };

  app.get("/healthz", c => c.json({ ok: true }));
  app.use("/v1/*", async (c, next) => {
    if (auth !== "network" && !tokenMatches(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/workspaces", async c => c.json({ workspaces: await provider.list() }));

  app.post("/v1/workspaces", async c => {
    const body = await c.req.json().catch(() => null);
    const repository = typeof body?.repository === "string" ? body.repository.trim() : "";
    if (!repository || repository.length > 300 || /\s/.test(repository)) return c.json({ error: "invalid_repository" }, 400);
    const name = body.name ?? slugFromRepository(repository);
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    const runtimeClassName = body.containers ? "kata" : null;
    const secretName = body.secretName || null;
    if (secretName && !K8S_NAME_RE.test(secretName)) return c.json({ error: "invalid_secret_name" }, 400);
    await provider.create({ name, repository, runtimeClassName, secretName });
    return c.json({ name }, 201);
  });

  app.delete("/v1/workspaces/:name", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    await provider.remove(name, { purge: c.req.query("purge") === "1" });
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:name/wake", named(async (c, name) => {
    lifecycle.touch(name);
    return await lifecycle.ensureAwake(name) ? c.json({ ok: true }) : starting(c, name);
  }));
  app.post("/v1/workspaces/:name/sleep", named(async (c, name) => {
    await lifecycle.sleep(name, "requested");
    return c.json({ ok: true });
  }));
  app.put("/v1/workspaces/:name/pin", named(async (c, name) => {
    const body = await c.req.json().catch(() => null);
    await provider.setPinned(name, !!body?.pinned);
    lifecycle.touch(name);
    return c.json({ ok: true, pinned: !!body?.pinned });
  }));

  app.put("/v1/github-auth", async c => {
    const body = await c.req.json().catch(() => null);
    await provider.setGitHubAuth(body?.accessToken ? body : null);
    return c.json({ ok: true });
  });

  // Body is web's Pi auth.json verbatim; workers link their auth.json to it.
  app.put("/v1/model-auth", async c => {
    const content = await c.req.text();
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error: "invalid_model_auth" }, 400);
    await provider.setModelAuth(content);
    return c.json({ ok: true });
  });

  app.all("/v1/workspaces/:name/api/*", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    const rest = c.req.path.slice(`/v1/workspaces/${name}`.length);
    // Web's own polling never wakes a worker; anything the user does does.
    if (PASSIVE.test(rest)) {
      if ((await lifecycle.info(name))?.state === "sleeping") return c.json({ error: "workspace_sleeping", name }, 503);
    } else if (!await lifecycle.ensureAwake(name)) return starting(c, name);
    const base = provider.upstream(name);
    if (!base) return c.json({ error: "workspace_unavailable", name }, 502);
    const raw = c.req.url;
    const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const target = base + rest + search;
    const active = !PASSIVE.test(rest);
    const headers = new Headers(c.req.raw.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let upstream;
    if (active) lifecycle.begin(name);
    try {
      upstream = await fetchImpl(target, { method: c.req.method, headers, body: hasBody ? c.req.raw.body : undefined, duplex: "half", signal: c.req.raw.signal, redirect: "manual" });
    } catch {
      return c.json({ error: "workspace_unavailable", name }, 502);
    } finally {
      if (active) lifecycle.end(name);
    }
    const out = new Headers(upstream.headers);
    for (const h of DROP_HEADERS) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  function starting(c, name) {
    c.header("retry-after", "5");
    return c.json({ error: "workspace_starting", name, message: "This project is starting. Try again in a few seconds." }, 503);
  }

  app.onError((e, c) => c.json({ error: e.code || "internal_error", message: e.message }, e.status || 500));
  return app;
}

async function providerFromEnv(env = process.env) {
  if ((env.WORKSPACED_PROVIDER || "local") === "kubernetes") {
    const { inClusterKube } = await import("./kube.js");
    const { kubernetesProvider } = await import("./kubernetes.js");
    return kubernetesProvider({ kube: inClusterKube() });
  }
  const { localProvider } = await import("./local.js");
  const provider = localProvider({ root: env.WORKSPACED_ROOT || `${env.HOME}/.pi-ez-workspaces` });
  await provider.init();
  return provider;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3150);
  const provider = await providerFromEnv();
  const idleMinutes = Number(process.env.WORKSPACED_IDLE_MINUTES ?? 5);
  const lifecycle = createLifecycle({ provider, idleMs: idleMinutes * 60_000 });
  serve({ fetch: createWorkspaced({ provider, lifecycle, token: process.env.WORKSPACED_TOKEN, auth: process.env.WORKSPACED_AUTH }).fetch, port, hostname: process.env.WORKSPACED_HOST || "0.0.0.0" });
  console.log(`workspaced (${process.env.WORKSPACED_PROVIDER || "local"}) → :${port}`);
}
