import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GitHubClient, GitHubDeviceFlowManager } from "../server/github.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) },
});

test("GitHub device flow stores token privately and exposes account only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-gh-"));
  const authFile = path.join(tmp, "github-auth.json");
  let tokenPolls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://github.com/login/device/code") {
      assert.match(String(init.body), /client_id=test-client/);
      assert.match(String(init.body), /scope=repo/);
      return jsonResponse({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 60 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      tokenPolls++;
      assert.doesNotMatch(String(init.body), /private-token/);
      return jsonResponse({ access_token: "gho_private-token", token_type: "bearer", scope: "repo,read:user" });
    }
    if (url === "https://api.github.com/user") {
      assert.equal(init.headers.authorization, "Bearer gho_private-token");
      return jsonResponse({ id: 42, login: "bry-guy" });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const client = new GitHubClient({ fetchImpl, authFile, configOverride: { clientId: "test-client", owner: null } });
    const manager = new GitHubDeviceFlowManager(client);
    const flow = await manager.start();
    assert.equal(flow.state, "waiting_user");
    assert.equal(manager.view(flow).deviceCode, undefined);
    await wait(15);
    const view = manager.view(flow);
    assert.equal(view.state, "complete");
    assert.deepEqual(view.account, { id: 42, login: "bry-guy" });
    assert.equal(tokenPolls, 1);
    const stored = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(stored.accessToken, "gho_private-token");
    assert.doesNotMatch(JSON.stringify(view), /private-token/);
    assert.equal(fs.statSync(authFile).mode & 0o077, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("public GitHub repository listing works without an auth token", async () => {
  let seenUrl;
  const client = new GitHubClient({ fetchImpl: async (url, init) => {
    seenUrl = url;
    assert.equal(init.headers.authorization, undefined);
    return jsonResponse([
      { id: 1, name: "pi-ez-web", full_name: "bry-guy/pi-ez-web", private: false, updated_at: "now", owner: { login: "bry-guy" } },
      { id: 2, name: "other", full_name: "bry-guy/other", private: false, updated_at: "now", owner: { login: "bry-guy" } },
    ]);
  }, configOverride: { clientId: null, owner: "bry-guy" }, authFile: "/tmp/piweb-test-github-does-not-exist" });
  const result = await client.listPublicRepositories({ query: "pi-ez" });
  assert.match(seenUrl, /users\/bry-guy\/repos/);
  assert.deepEqual(result.repos.map(repo => repo.fullName), ["bry-guy/pi-ez-web"]);
});

test("GitHub repository metadata can resolve a public repo without auth", async () => {
  const client = new GitHubClient({ fetchImpl: async (url, init) => {
    assert.equal(init.headers.authorization, undefined);
    assert.match(url, /repos\/bry-guy\/pi-ez-web/);
    return jsonResponse({ id: 1, name: "pi-ez-web", full_name: "bry-guy/pi-ez-web", private: false, clone_url: "https://github.com/bry-guy/pi-ez-web.git", owner: { login: "bry-guy" } });
  }, configOverride: { clientId: null, owner: "bry-guy" }, authFile: "/tmp/piweb-test-github-does-not-exist" });
  const result = await client.repository("bry-guy/pi-ez-web");
  assert.equal(result.cloneUrl, "https://github.com/bry-guy/pi-ez-web.git");
});

test("GitHub repository listing applies owner and query filters", async () => {
  const client = new GitHubClient({ fetchImpl: async (url, init) => {
    assert.match(url, /user\/repos/);
    assert.equal(init.headers.authorization, "Bearer stored-token");
    return jsonResponse([
      { id: 1, name: "infra", full_name: "bry-guy/infra", private: true, updated_at: "now", owner: { login: "bry-guy" } },
      { id: 2, name: "other", full_name: "someone/other", private: false, updated_at: "now", owner: { login: "someone" } },
    ], { headers: { link: "<https://api.github.com/user/repos?page=2>; rel=\"next\"" } });
  }, authFile: "/tmp/piweb-test-github-does-not-exist" });
  // Avoid environment/config credential dependence in this test.
  client.effectiveAuth = () => ({ accessToken: "stored-token", source: "stored" });
  const result = await client.listRepositories({ query: "infra", page: 1 });
  assert.deepEqual(result.repos.map(repo => repo.fullName), ["bry-guy/infra"]);
  assert.equal(result.nextPage, 2);
});
