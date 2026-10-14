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
import { kubernetesConfig, kubernetesProvider } from "../workspaced/kubernetes.js";
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
  const kata = deploymentManifest({ ...base, runtimeClassName: "kata", serviceAccountName: "ws-x" }).spec.template.spec;
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
  assert.deepEqual(await provider.list(), [{ name: "srvivor", repository: "bry-guy/srvivor", ready: true, containers: false }]);
  await provider.setGitHubAuth({ accessToken: "t" });
  assert.equal(statSync(path.join(root, "github-auth.json")).mode & 0o777, 0o600);
  await assert.rejects(provider.create({ name: "srvivor", repository: "x/srvivor" }), { code: "workspace_name_taken" });
  const again = localProvider({ root, spawnImpl });
  await again.init();
  assert.equal(spawned.length, 2, "init restarts registered workers");
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "workspaces.json"), "utf8")), { srvivor: { repository: "bry-guy/srvivor" } });
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
