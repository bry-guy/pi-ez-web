import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { serve } from "@hono/node-server";
import { createGateway, gatewayConfig } from "../server/gateway/index.js";
import { deploymentManifest, slugFromRepository } from "../server/gateway/manifests.js";

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

function fakeKube(routes = {}) {
  const calls = [];
  return { calls, request: async (method, path, body) => {
    calls.push([method, path, body?.kind]);
    return routes[`${method} ${path}`] || (method === "POST" ? { status: 409, body: {} } : { status: 404, body: {} });
  } };
}

test("create is idempotent, applies the SA convention, and refuses name collisions", async () => {
  const ns = "/api/v1/namespaces/pi-ez-workspaces";
  const kube = fakeKube({ [`GET ${ns}/serviceaccounts/ws-srvivor`]: { status: 200, body: {} } });
  const gw = createGateway({ kube, config: gatewayConfig({}) });
  const res = await gw.request("/api/gateway/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "bry-guy/srvivor" }) });
  assert.equal(res.status, 201);
  assert.deepEqual(kube.calls.filter(c => c[0] === "POST").map(c => c[2]), ["PersistentVolumeClaim", "Service", "Deployment"]);

  const taken = fakeKube({ "GET /apis/apps/v1/namespaces/pi-ez-workspaces/deployments/ws-srvivor": { status: 200, body: { metadata: { annotations: { "pi-ez.dev/repository": "other/srvivor" } } } } });
  const res2 = await createGateway({ kube: taken, config: gatewayConfig({}) }).request("/api/gateway/workspaces", { method: "POST", body: JSON.stringify({ repository: "bry-guy/srvivor" }) });
  assert.equal(res2.status, 409);

  const bad = await gw.request("/api/gateway/workspaces", { method: "POST", body: JSON.stringify({ repository: "a/b", name: "../etc" }) });
  assert.equal(bad.status, 400);
  assert.equal((await gw.request("/w/..%2Fx/api")).status, 404);
});

test("proxy strips the prefix, sets X-Forwarded-Prefix, and streams SSE", async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { url: req.url, prefix: req.headers["x-forwarded-prefix"] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.end("data: two\n\n"), 200);
  });
  await new Promise(r => upstream.listen(0, r));
  const config = { ...gatewayConfig({}), upstream: () => `http://127.0.0.1:${upstream.address().port}` };
  const server = serve({ fetch: createGateway({ kube: fakeKube(), config }).fetch, port: 0 });
  await new Promise(r => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/w/demo/api/events?x=1`);
    const reader = res.body.getReader();
    const start = Date.now();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /one/);
    assert.ok(Date.now() - start < 150, "first event must arrive before the upstream finishes");
    assert.deepEqual(seen, { url: "/api/events?x=1", prefix: "/w/demo" });
    await reader.cancel();
  } finally {
    server.close();
    upstream.close();
  }
});

test("workspaces mount the shared GitHub login read-only and optionally", () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec;
  const vol = spec.volumes.find(v => v.name === "github");
  assert.equal(vol.secret.secretName, "pi-ez-github-auth");
  assert.equal(vol.secret.optional, true);
  assert.ok(spec.containers[0].volumeMounts.find(m => m.name === "github").readOnly);
  assert.ok(spec.containers[0].env.some(e => e.name === "PI_WEB_GITHUB_AUTH_FILE"));
});

test("gateway GitHub status reads the shared Secret and logout deletes it", async () => {
  const path = "/api/v1/namespaces/pi-ez-workspaces/secrets/pi-ez-github-auth";
  const data = Buffer.from(JSON.stringify({ accessToken: "t", account: { login: "me" } })).toString("base64");
  const kube = fakeKube({ [`GET ${path}`]: { status: 200, body: { data: { "github-auth.json": data } } }, [`DELETE ${path}`]: { status: 200, body: {} } });
  const gw = createGateway({ kube, config: gatewayConfig({ PI_WEB_GITHUB_CLIENT_ID: "cid" }) });
  const status = await (await gw.request("/api/gateway/github")).json();
  assert.deepEqual(status, { configured: true, authenticated: true, account: { login: "me" } });
  assert.equal(JSON.stringify(status).includes('"t"'), false);
  await gw.request("/api/gateway/github/logout", { method: "POST" });
  assert.ok(kube.calls.some(([m, p]) => m === "DELETE" && p === path));
});
