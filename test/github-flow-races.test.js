import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubDeviceFlowManager } from "../server/github.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const device = {
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  intervalSeconds: 1,
  expiresInSeconds: 60,
};

test("GitHub device flow denies concurrent starts while the first start is pending", async t => {
  const pendingStart = deferred();
  let startCalls = 0;
  const manager = new GitHubDeviceFlowManager({
    startDeviceFlow() { startCalls++; return pendingStart.promise; },
    pollDeviceFlow: async () => ({ state: "pending" }),
  });

  const firstStart = manager.start();
  await assert.rejects(manager.start(), error => error.code === "github_flow_active");
  assert.equal(startCalls, 1);

  pendingStart.resolve(device);
  const flow = await firstStart;
  t.after(() => clearTimeout(flow.timer));
  manager.cancel(flow.id);
  assert.equal(flow.state, "cancelled");
});

test("GitHub device flow releases its reservation after a failed start", async t => {
  const failedStart = deferred();
  let startCalls = 0;
  const manager = new GitHubDeviceFlowManager({
    startDeviceFlow() { return ++startCalls === 1 ? failedStart.promise : Promise.resolve(device); },
    pollDeviceFlow: async () => ({ state: "pending" }),
  });

  const attempt = manager.start();
  failedStart.reject(Object.assign(new Error("temporary failure"), { code: "github_unavailable" }));
  await assert.rejects(attempt, { code: "github_unavailable" });
  const flow = await manager.start();
  t.after(() => clearTimeout(flow.timer));
  assert.equal(flow.state, "waiting_user");
  assert.equal(startCalls, 2);
  manager.cancel(flow.id);
});

test("cancelling during device polling ignores a late complete response", async t => {
  const pendingPoll = deferred();
  const pollStarted = deferred();
  let accountCalls = 0;
  let savedTokens = 0;
  const manager = new GitHubDeviceFlowManager({
    startDeviceFlow: async () => device,
    pollDeviceFlow() { pollStarted.resolve(); return pendingPoll.promise; },
    accountForToken: async () => { accountCalls++; return { id: 1, login: "test" }; },
    saveToken() { savedTokens++; },
  });

  const flow = await manager.start();
  t.after(() => clearTimeout(flow.timer));
  clearTimeout(flow.timer);
  const polling = manager.poll(flow);
  await pollStarted.promise;
  manager.cancel(flow.id);
  const terminalTimer = flow.timer;
  pendingPoll.resolve({ state: "complete", accessToken: "test-token", tokenType: "bearer", scope: "repo" });
  await polling;

  assert.equal(flow.state, "cancelled");
  assert.equal(flow.timer, terminalTimer);
  assert.equal(accountCalls, 0);
  assert.equal(savedTokens, 0);
});

test("cancelling during device polling ignores a late pending response", async t => {
  const pendingPoll = deferred();
  const pollStarted = deferred();
  const manager = new GitHubDeviceFlowManager({
    startDeviceFlow: async () => device,
    pollDeviceFlow() { pollStarted.resolve(); return pendingPoll.promise; },
  });

  const flow = await manager.start();
  t.after(() => clearTimeout(flow.timer));
  clearTimeout(flow.timer);
  const polling = manager.poll(flow);
  await pollStarted.promise;
  manager.cancel(flow.id);
  const terminalTimer = flow.timer;
  pendingPoll.resolve({ state: "pending" });
  await polling;

  assert.equal(flow.state, "cancelled");
  assert.equal(flow.timer, terminalTimer);
});

test("cancelling during account validation does not persist the token", async t => {
  const pendingAccount = deferred();
  const accountStarted = deferred();
  let savedTokens = 0;
  const manager = new GitHubDeviceFlowManager({
    startDeviceFlow: async () => device,
    pollDeviceFlow: async () => ({ state: "complete", accessToken: "test-token", tokenType: "bearer", scope: "repo" }),
    accountForToken() { accountStarted.resolve(); return pendingAccount.promise; },
    saveToken() { savedTokens++; },
  });

  const flow = await manager.start();
  t.after(() => clearTimeout(flow.timer));
  clearTimeout(flow.timer);
  const polling = manager.poll(flow);
  await accountStarted.promise;
  manager.cancel(flow.id);
  const terminalTimer = flow.timer;
  pendingAccount.resolve({ id: 1, login: "test" });
  await polling;

  assert.equal(flow.state, "cancelled");
  assert.equal(flow.timer, terminalTimer);
  assert.equal(savedTokens, 0);
});
