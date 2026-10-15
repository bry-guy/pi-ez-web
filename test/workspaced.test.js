import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createWorkspaced } from "../workspaced/index.js";
import { deploymentState, kubernetesConfig, kubernetesProvider } from "../workspaced/kubernetes.js";
import { createLifecycle } from "../workspaced/lifecycle.js";
import { parseGrants, repoKey, withGrantCheck } from "../workspaced/grants.js";
import { localProvider } from "../workspaced/local.js";
import { deploymentManifest, slugFromRepository } from "../workspaced/manifests.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = body => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("slugs are DNS-safe and reject garbage", () => {
  assert.equal(slugFromRepository("https://github.com/bry-guy/srvivor.git"), "srvivor");
  assert.equal(slugFromRepository("bry-guy/Personal_Finances"), "personal-finances");
  assert.equal(slugFromRepository("git@github.com:a/b"), "b");
  assert.equal(slugFromRepository("///"), null);
});

test("privileged docker sidecar only exists under a sandbox runtime class", () => {
  const base = { name: "x", repository: "a/x", image: "img" };
  const plain = deploymentManifest(base).spec.template.spec;
  assert.equal(plain.containers.length, 1);
  assert.equal(plain.runtimeClassName, undefined);
  assert.equal(plain.automountServiceAccountToken, false);
  const kata = deploymentManifest({ ...base, runtimeClassName: "kata", grant: { name: "g", env: [], serviceAccount: "ws-x" } }).spec.template.spec;
  assert.equal(kata.runtimeClassName, "kata");
  assert.equal(kata.containers[1].securityContext.privileged, true);
  assert.equal(kata.serviceAccountName, "ws-x");
  assert.ok(kata.containers[0].env.some(e => e.name === "DOCKER_HOST"));
});

test("workers mount the shared GitHub login read-only and optionally", () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec;
  const vol = spec.volumes.find(v => v.name === "github");
  assert.equal(vol.secret.secretName, "pi-ez-github-auth");
  assert.equal(vol.secret.optional, true);
  assert.ok(spec.containers[0].volumeMounts.find(m => m.name === "github").readOnly);
});

function fakeKube(routes = {}) {
  const calls = [];
  return { calls, request: async (method, p, body) => {
    calls.push([method, p, body?.kind]);
    return routes[`${method} ${p}`] || (method === "POST" ? { status: 409, body: {} } : { status: 404, body: {} });
  } };
}

test("workspaced requires its token", async () => {
  const app = createWorkspaced({ provider: { list: async () => [] }, token: TOKEN });
  assert.equal((await app.request("/v1/workspaces")).status, 401);
  assert.equal((await app.request("/v1/workspaces", { headers: { authorization: "Bearer nope-nope-no" } })).status, 401);
  assert.equal((await app.request("/v1/workspaces", { headers: auth })).status, 200);
  assert.equal((await app.request("/healthz")).status, 200);
  assert.throws(() => createWorkspaced({ provider: {} }), /WORKSPACED_TOKEN/);
  const network = createWorkspaced({ provider: { list: async () => [] }, auth: "network" });
  assert.equal((await network.request("/v1/workspaces")).status, 200);
});

test("kubernetes create is idempotent, applies the SA convention, and refuses name collisions", async () => {
  const ns = "/api/v1/namespaces/pi-ez-workspaces";
  const kube = fakeKube({ [`GET ${ns}/serviceaccounts/ws-srvivor`]: { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app.request("/v1/workspaces", json({ repository: "bry-guy/srvivor", containers: true }))).status, 201);
  assert.deepEqual(kube.calls.filter(c => c[0] === "POST").map(c => c[2]), ["PersistentVolumeClaim", "Service", "Deployment"]);

  const taken = fakeKube({ "GET /apis/apps/v1/namespaces/pi-ez-workspaces/deployments/ws-srvivor": { status: 200, body: { metadata: { annotations: { "pi-ez.dev/repository": "other/srvivor" } } } } });
  const app2 = createWorkspaced({ provider: kubernetesProvider({ kube: taken, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app2.request("/v1/workspaces", json({ repository: "bry-guy/srvivor" }))).status, 409);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "a/b", name: "../etc" }))).status, 400);
});

test("kubernetes GitHub auth goes to the shared Secret", async () => {
  const kube = fakeKube({ "PUT /api/v1/namespaces/pi-ez-workspaces/secrets/pi-ez-github-auth": { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app.request("/v1/github-auth", { ...json({ accessToken: "t" }), method: "PUT" })).status, 200);
  assert.ok(kube.calls.some(([m, p]) => m === "PUT" && p.endsWith("/pi-ez-github-auth")));
});

test("local provider persists workspaces, spawns workers, and writes auth 0600", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspaced-"));
  const spawned = [];
  const spawnImpl = (_bin, _args, opts) => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; }; spawned.push(opts.env); return child; };
  const provider = localProvider({ root, spawnImpl });
  await provider.create({ name: "srvivor", repository: "bry-guy/srvivor" });
  assert.equal(spawned[0].PI_WEB_REPOS_ROOT, path.join(root, "srvivor", "repos"));
  assert.match(provider.upstream("srvivor"), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await provider.list(), [{ name: "srvivor", repository: "bry-guy/srvivor", grant: "default", ready: true, state: "running", pinned: false, containers: false }]);
  await provider.setGitHubAuth({ accessToken: "t" });
  assert.equal(statSync(path.join(root, "github-auth.json")).mode & 0o777, 0o600);
  await assert.rejects(provider.create({ name: "srvivor", repository: "x/srvivor" }), { code: "workspace_name_taken" });
  const again = localProvider({ root, spawnImpl });
  await again.init();
  assert.equal(spawned.length, 2, "init restarts registered workers");
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "workspaces.json"), "utf8")), { srvivor: { repository: "bry-guy/srvivor", grant: "default" } });
  await again.scale("srvivor", 0);
  await again.setPinned("srvivor", true);
  assert.deepEqual((await again.list()).map(w => [w.state, w.pinned]), [["sleeping", true]]);
  const third = localProvider({ root, spawnImpl });
  await third.init();
  assert.equal(spawned.length, 2, "sleeping workers stay asleep across restarts");
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

test("web routes owned ids to workers, merges state, and re-sequences events", async () => {
  // Fake worker: one project with one session, and an event stream.
  const worker = await listen((req, res) => {
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [{ id: "p1", name: "srvivor", sessions: [{ id: "s1" }] }] }));
    if (req.url === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ v: 1, seq: 99, sessionId: "s1", type: "token", text: "hi" })}\n\n`); return undefined; }
    return res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const provider = { list: async () => [{ name: "srvivor", ready: true }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const hub = new EventHub();
  const frames = [];
  hub.addClient(f => frames.push(f));
  const remote = createRemoteWorkspaces({ url: `http://127.0.0.1:${daemon.address().port}`, token: TOKEN, hub, retryMs: 50, modelAuthSyncMs: 0 });
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    api.all("*", c => c.json({ local: true }));
    const projects = await remote.projects();
    assert.deepEqual(projects.map(p => [p.id, p.workspace]), [["p1", "srvivor"]]);
    assert.deepEqual(await (await api.request("/sessions/s1/message", { method: "POST", body: "{}" })).json(), { path: "/api/sessions/s1/message", method: "POST" });
    assert.deepEqual(await (await api.request("/sessions/local-chat/message", { method: "POST" })).json(), { local: true });
    // Projects exist only in workers and only from GitHub or Git URLs.
    const local = await api.request("/projects", { method: "POST", body: JSON.stringify({ source: "local", repoPath: "/tmp" }) });
    assert.equal(local.status, 400);
    assert.deepEqual(await local.json(), { error: "unsupported_repository_source" });
    for (let i = 0; i < 50 && !frames.some(f => f.includes("token")); i++) await new Promise(r => setTimeout(r, 20));
    const evt = JSON.parse(frames.find(f => f.includes("token")).split("data: ")[1]);
    assert.equal(evt.seq, 1, "web renumbers worker events");
    assert.equal(evt.sessionId, "s1");
  } finally {
    remote.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("model logins go to a read-only Secret that workers link auth.json to", async () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec;
  const vol = spec.volumes.find(v => v.name === "model");
  assert.deepEqual([vol.secret.secretName, vol.secret.optional], ["pi-ez-model-auth", true]);
  assert.ok(spec.containers[0].volumeMounts.find(m => m.name === "model").readOnly);
  const env = Object.fromEntries(spec.containers[0].env.map(e => [e.name, e.value]));
  assert.equal(env.PI_WEB_MODEL_AUTH_FILE, "/run/secrets/pi-ez-model/auth.json");

  const kube = fakeKube({ "PUT /api/v1/namespaces/pi-ez-workspaces/secrets/pi-ez-model-auth": { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  const put = body => app.request("/v1/model-auth", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body });
  assert.equal((await put("[]")).status, 400);
  assert.equal((await put("nope")).status, 400);
  assert.equal((await put('{"anthropic":{"type":"oauth"}}')).status, 200);
  assert.ok(kube.calls.some(([m, p]) => m === "PUT" && p.endsWith("/pi-ez-model-auth")));
});

test("workers replace auth.json with a link to the shared model login", async () => {
  const { linkModelAuth } = await import("../server/index.js");
  const dir = mkdtempSync(path.join(tmpdir(), "model-auth-"));
  const target = path.join(dir, "shared.json");
  writeFileSync(target, '{"a":1}');
  writeFileSync(path.join(dir, "auth.json"), "{}");
  const env = { PI_WEB_MODEL_AUTH_FILE: target, PI_CODING_AGENT_DIR: dir };
  linkModelAuth(env);
  linkModelAuth(env);
  assert.equal(readlinkSync(path.join(dir, "auth.json")), target);
  assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), '{"a":1}');
});

test("web refreshes OAuth at 30 minutes and republishes model logins only on change", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "model-push-"));
  const authPath = path.join(dir, "auth.json");
  writeFileSync(authPath, '{"v":1}');
  const refreshed = [];
  const runtime = {
    listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }, { providerId: "k", type: "api_key" }],
    getAuth: async (id, opts) => { refreshed.push([id, opts.minOAuthValidityMs]); },
  };
  const puts = [];
  const fetchImpl = async (url, init) => { puts.push([url, init.body]); return new Response("{}", { status: 200 }); };
  const remote = createRemoteWorkspaces({ url: "http://w", token: TOKEN, sup: { _modelRuntime: async () => runtime }, modelAuthPath: authPath, fetchImpl, modelAuthSyncMs: 0 });
  await remote.pushModelAuth();
  await remote.pushModelAuth();
  writeFileSync(authPath, '{"v":2}');
  await remote.pushModelAuth();
  assert.deepEqual(refreshed[0], ["anthropic", 30 * 60_000]);
  assert.ok(refreshed.every(([id]) => id === "anthropic"));
  assert.deepEqual(puts.map(([u, b]) => [u, b]), [["http://w/v1/model-auth", '{"v":1}'], ["http://w/v1/model-auth", '{"v":2}']]);
  remote.stop();
});

test("kubernetes remove waits until the pod and purged PVC are gone", async () => {
  let polls = 0;
  const kube = { request: async (method, p) => {
    if (method === "DELETE") return { status: 200, body: {} };
    if (p.includes("/pods?")) return { status: 200, body: { items: ++polls < 3 ? [{}] : [] } };
    return { status: polls < 3 ? 200 : 404, body: {} };
  } };
  await kubernetesProvider({ kube, config: kubernetesConfig({}), removePollMs: 1 }).remove("x", { purge: true });
  assert.equal(polls, 3);
  const stuck = { request: async (m, p) => m === "DELETE" ? { status: 200 } : { status: 200, body: { items: p.includes("/pods?") ? [{}] : [] } } };
  await assert.rejects(kubernetesProvider({ kube: stuck, config: kubernetesConfig({}), removeTimeoutMs: 5, removePollMs: 1 }).remove("x"), { code: "workspace_remove_timeout" });
});

function fakeLifecycleProvider(workerPort) {
  const ws = { name: "app", repository: "o/app", state: "sleeping", pinned: false };
  const calls = [];
  return {
    ws, calls,
    list: async () => [{ ...ws }],
    upstream: () => `http://127.0.0.1:${workerPort}`,
    scale: async (_name, n) => { calls.push(["scale", n]); ws.state = n ? "running" : "sleeping"; },
    setPinned: async (_name, pinned) => { calls.push(["pin", pinned]); ws.pinned = pinned; },
  };
}

test("passive calls never wake a sleeping worker; user calls wake it", async () => {
  const worker = await listen((req, res) => res.end(JSON.stringify({ ok: true, path: req.url, busy: false })));
  const provider = fakeLifecycleProvider(worker.address().port);
  const lifecycle = createLifecycle({ provider, idleMs: 0, pollMs: 5, cacheMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  try {
    for (const p of ["/api/events", "/api/state", "/api/health"]) {
      const res = await app.request(`/v1/workspaces/app${p}`, { headers: auth });
      assert.equal(res.status, 503, p);
      assert.equal((await res.json()).error, "workspace_sleeping");
    }
    assert.deepEqual(provider.calls, [], "no scale from passive calls");
    const res = await app.request("/v1/workspaces/app/api/sessions/s1/message", { method: "POST", headers: auth, body: "{}" });
    assert.equal(res.status, 200);
    assert.deepEqual(provider.calls, [["scale", 1]]);
  } finally { worker.close(); }
});

test("a worker that does not come up in time answers 503 workspace_starting", async () => {
  const provider = fakeLifecycleProvider(1);
  provider.upstream = () => "http://127.0.0.1:1";
  const lifecycle = createLifecycle({ provider, idleMs: 0, pollMs: 5, wakeTimeoutMs: 30, cacheMs: 0, log: () => {} });
  const res = await createWorkspaced({ provider, token: TOKEN, lifecycle }).request("/v1/workspaces/app/api/files", { headers: auth });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  assert.equal((await res.json()).error, "workspace_starting");
});

test("sweeper sleeps idle workers, but not pinned, busy, or recently used ones", async () => {
  let busy = false;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy })));
  const provider = fakeLifecycleProvider(worker.address().port);
  provider.ws.state = "running";
  let clock = 0;
  const lifecycle = createLifecycle({ provider, idleMs: 1000, sweepMs: 0, cacheMs: 0, now: () => clock, log: () => {} });
  try {
    await lifecycle.sweep();
    clock = 500; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "recently seen");
    clock = 2000; provider.ws.pinned = true; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "pinned");
    provider.ws.pinned = false; busy = true; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "agent turn running");
    clock = 4000; lifecycle.begin("app"); await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "request in flight");
    lifecycle.end("app"); busy = false; clock = 6000; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [["scale", 0]]);
  } finally { worker.close(); }
});

test("kubernetes scale and pin are merge patches on the Deployment", async () => {
  const seen = [];
  const kube = { request: async (method, p, body, type) => { seen.push([method, p, body, type]); return { status: 200, body: {} }; } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}) });
  await provider.scale("app", 0);
  await provider.setPinned("app", true);
  const patches = seen.filter(s => s[0] === "PATCH");
  assert.deepEqual(patches.map(s => [s[1].split("/").pop(), s[3]]), [["ws-app", "application/merge-patch+json"], ["ws-app", "application/merge-patch+json"]]);
  assert.deepEqual(patches[0][2], { spec: { replicas: 0 } });
  assert.deepEqual(patches[1][2], { metadata: { annotations: { "pi-ez.dev/keep-awake": "true" } } });
  assert.equal(deploymentState({ spec: { replicas: 0 } }), "sleeping");
  assert.equal(deploymentState({ spec: { replicas: 1 }, status: {} }), "starting");
  assert.equal(deploymentState({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), "running");
  const d = deploymentManifest({ name: "app", repository: "o/app", image: "img" });
  assert.equal(d.spec.template.spec.enableServiceLinks, false);
  assert.equal(d.spec.template.spec.containers[0].readinessProbe.periodSeconds, 1);
});

test("web keeps sleeping projects in the sidebar from a persisted snapshot", async () => {
  let state = "running";
  const worker = await listen((req, res) => {
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [{ id: "p1", name: "app", sessions: [{ id: "s1" }] }] }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    return undefined;
  });
  const provider = { list: async () => [{ name: "app", ready: state === "running", state, pinned: false }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "pz-cache-")), "remote-projects.json");
  const url = `http://127.0.0.1:${daemon.address().port}`;
  const make = () => createRemoteWorkspaces({ url, token: TOKEN, hub: new EventHub(), cachePath, retryMs: 50, modelAuthSyncMs: 0 });
  const first = make();
  try {
    assert.deepEqual((await first.projects()).map(p => [p.id, p.workspaceState]), [["p1", "running"]]);
    first.stop();
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    state = "sleeping";
    const restarted = make();
    try {
      assert.deepEqual((await restarted.projects()).map(p => [p.id, p.workspaceState, p.sessions.length]), [["p1", "sleeping", 1]]);
      assert.equal(await restarted.owner("session", "s1"), "app", "ownership survives a web restart");
    } finally { restarted.stop(); }
  } finally {
    first.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("grants: repo-locked grants refuse other repositories, also on wake", async () => {
  const grants = parseGrants(JSON.stringify({
    default: { anyProject: true },
    operator: { repos: ["bry-guy/infra"], namespace: "pi-ez-operator", serviceAccount: "infra-operator", env: ["operator-env"], egress: "open" },
  }));
  assert.throws(() => parseGrants(JSON.stringify({ x: { anyProject: true } })), /default/);
  assert.throws(() => parseGrants(JSON.stringify({ default: { anyProject: true }, y: {} })), /anyProject or repos/);
  assert.equal(repoKey("https://github.com/Bry-Guy/infra.git"), "bry-guy/infra");
  assert.equal(repoKey("git@github.com:bry-guy/infra"), "bry-guy/infra");
  const created = [];
  let listed = [];
  const provider = { list: async () => listed, create: async w => created.push(w), scale: async () => "scaled", setGrant: async (_n, g) => created.push({ regrant: g.name }) };
  const app = createWorkspaced({ provider, grants, auth: "network" });
  const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis", grant: "operator" }))).status, 403);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis", grant: "nope" }))).status, 400);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis" }))).status, 201);
  assert.equal(created[0].grant.name, "default");
  assert.equal((await app.request("/v1/workspaces", json({ repository: "https://github.com/bry-guy/infra", grant: "operator" }))).status, 201);
  assert.equal(created[1].grant.serviceAccount, "infra-operator");
  const offered = await (await app.request("/v1/grants?repository=redis/redis")).json();
  assert.deepEqual(offered.grants.map(g => g.name), ["default"]);
  listed = [{ name: "redis", repository: "redis/redis", grant: "default" }];
  const put = grant => app.request("/v1/workspaces/redis/grant", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
  assert.equal((await put("operator")).status, 403);
  assert.equal((await put("default")).status, 200);
  // A worker whose grant no longer allows its repo cannot be woken.
  const guarded = withGrantCheck(provider, grants);
  listed = [{ name: "redis", repository: "redis/redis", grant: "operator" }];
  await assert.rejects(guarded.scale("redis", 1), { code: "grant_not_allowed" });
  assert.equal(await guarded.scale("redis", 0), "scaled");
});

test("grants: manifests and the kubernetes provider honour namespace, SA, env and egress", async () => {
  const grant = parseGrants(JSON.stringify({ default: { anyProject: true }, operator: { repos: ["o/infra"], namespace: "ops", serviceAccount: "op", env: ["op-env"], egress: "open" } })).operator;
  const d = deploymentManifest({ name: "infra", repository: "o/infra", image: "img", grant });
  const pod = d.spec.template;
  assert.equal(d.metadata.annotations["pi-ez.dev/grant"], "operator");
  assert.equal(pod.metadata.labels["pi-ez.dev/egress"], "open");
  assert.equal(pod.spec.serviceAccountName, "op");
  assert.deepEqual(pod.spec.containers[0].envFrom, [{ secretRef: { name: "op-env", optional: true } }]);
  const plain = deploymentManifest({ name: "r", repository: "r/r", image: "img" }).spec.template;
  assert.equal(plain.spec.automountServiceAccountToken, false);
  assert.equal(plain.metadata.labels["pi-ez.dev/egress"], undefined);
  const posts = [];
  const kube = { request: async (method, p, body) => {
    if (method === "POST") { posts.push(p); return { status: 201, body: {} }; }
    if (method === "GET" && p.includes("?")) return { status: 200, body: { items: p.includes("/namespaces/ops/") ? [{ metadata: { labels: { "pi-ez.dev/workspace": "infra" }, annotations: { "pi-ez.dev/repository": "o/infra", "pi-ez.dev/grant": "operator" } }, spec: { replicas: 1 }, status: {} }] : [] } };
    return { status: 404, body: {} };
  } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}), grants: { operator: grant } });
  await provider.create({ name: "infra", repository: "o/infra", grant });
  assert.ok(posts.every(p => p.includes("/namespaces/ops/")), posts.join());
  const [w] = await provider.list();
  assert.equal(w.grant, "operator");
  assert.equal(provider.upstream("infra"), "http://ws-infra.ops.svc.cluster.local:3141");
});

test("waking past the limit sleeps the least recently used idle worker first", async () => {
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy: false })));
  const states = { a: "running", b: "running", c: "sleeping" };
  const pinned = {};
  const calls = [];
  const provider = {
    list: async () => Object.entries(states).map(([name, state]) => ({ name, state, pinned: !!pinned[name] })),
    upstream: () => `http://127.0.0.1:${worker.address().port}`,
    scale: async (name, n) => { calls.push([name, n]); states[name] = n ? "running" : "sleeping"; },
  };
  let clock = 0;
  const lifecycle = createLifecycle({ provider, maxAwake: 2, sweepMs: 0, pollMs: 1, cacheMs: 0, now: () => clock, log: () => {} });
  try {
    await lifecycle.refresh();
    clock = 10; lifecycle.touch("a"); clock = 20; lifecycle.touch("b");
    assert.equal(await lifecycle.ensureAwake("c"), true);
    assert.deepEqual(calls, [["a", 0], ["c", 1]], "a was used least recently");
    pinned.b = true; states.a = "running"; clock = 30; lifecycle.touch("c"); clock = 40; lifecycle.touch("a");
    await lifecycle.sweep();
    assert.deepEqual(calls.at(-1), ["c", 0], "pinned b is never chosen");
  } finally { worker.close(); }
});
