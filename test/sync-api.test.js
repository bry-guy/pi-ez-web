import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildApi } from "../server/routes.js";
import { EventHub } from "../server/events.js";
import { chatsDir, ensureHome, saveConfig } from "../server/config.js";
import { MockSupervisor } from "../server/supervisor/mock.js";
import { FakeSyncCoordinator } from "../server/sync/coordinator.js";

let home;
let api;
let supervisor;
let coordinator;
const previous = {
  home: process.env.PI_WEB_HOME,
  mode: process.env.PI_WEB_MODE,
  syncMode: process.env.PI_WEB_SYNC_MODE,
};

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-sync-api-"));
  process.env.PI_WEB_HOME = home;
  process.env.PI_WEB_MODE = "mock";
  process.env.PI_WEB_SYNC_MODE = "fake";
  ensureHome();
  saveConfig({ sync: { serverUrl: "https://fake.example", allConversations: false } });
  supervisor = new MockSupervisor(new EventHub());
  coordinator = new FakeSyncCoordinator({ supervisor });
  api = buildApi(supervisor, { syncCoordinator: coordinator });
});

after(() => {
  for (const [key, value] of [["PI_WEB_HOME", previous.home], ["PI_WEB_MODE", previous.mode], ["PI_WEB_SYNC_MODE", previous.syncMode]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function json(pathname, options) {
  const response = await api.request(`http://sync.test${pathname}`, options);
  return { response, body: await response.json() };
}

test("sync state is exposed and enrollment updates the session row", async () => {
  const created = await supervisor.createSession({ cwd: chatsDir() });
  const initial = await json("/state");
  assert.equal(initial.body.sync.version, 1);
  assert.equal(initial.body.sync.connection, "available");
  assert.equal(initial.body.chats.find(chat => chat.id === created.id).syncState, "pending");

  const enrolled = await json(`/sessions/${created.id}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(enrolled.response.status, 200);
  assert.equal(enrolled.body.synchronized, true);
  assert.equal(enrolled.body.created, true);

  const after = await json("/state");
  const row = after.body.chats.find(chat => chat.id === created.id);
  assert.equal(row.synchronized, true);
  assert.equal(row.syncState, "available");
});

test("refresh pulls the canonical snapshot and releases its lease", async () => {
  const created = await supervisor.createSession({ cwd: chatsDir() });
  await json(`/sessions/${created.id}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const passive = await json(`/sessions/${created.id}/sync`);
  assert.equal(passive.response.status, 200);
  assert.equal(coordinator.active.has(created.id), false);
  const refreshed = await json(`/sessions/${created.id}/sync/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.refreshed, true);
  assert.equal(coordinator.active.has(created.id), false);
});

test("refresh returns 423 for an active lease without materializing", async () => {
  const created = await supervisor.createSession({ cwd: chatsDir() });
  await json(`/sessions/${created.id}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const file = (await supervisor.syncSessionInfo(created.id)).file;
  const before = fs.readFileSync(file);
  coordinator.setLeaseHolder(created.id, "other-client");
  const blocked = await json(`/sessions/${created.id}/sync/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(blocked.response.status, 423);
  assert.equal(blocked.body.error, "active_lease");
  assert.deepEqual(fs.readFileSync(file), before);
  coordinator.setLeaseHolder(created.id);
});

test("sync enrollment is blocked while a mock session is streaming", async () => {
  const created = await supervisor.createSession({ cwd: chatsDir() });
  await supervisor.message(created.id, "slow turn");
  const blocked = await json(`/sessions/${created.id}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error, "session_streaming");
  await supervisor.stop(created.id);
});
