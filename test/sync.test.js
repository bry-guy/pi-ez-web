import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, normalizeSyncConfig, saveConfig, syncConfig, syncSettingsState } from "../server/config.js";
import { FakeSyncCoordinator } from "../server/sync/coordinator.js";
import { isSyncEnrolled, loadSyncSessions, markSyncEnrolled, markSyncPending, syncSessionsPath } from "../server/sync/enrollment.js";

let home;
const previous = {
  home: process.env.PI_WEB_HOME,
  server: process.env.PI_WEB_SYNC_SERVER_URL,
  all: process.env.PI_WEB_SYNC_ALL_CONVERSATIONS,
};

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-sync-"));
  process.env.PI_WEB_HOME = home;
  delete process.env.PI_WEB_SYNC_SERVER_URL;
  delete process.env.PI_WEB_SYNC_ALL_CONVERSATIONS;
});

after(() => {
  if (previous.home === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previous.home;
  for (const [key, value] of [["PI_WEB_SYNC_SERVER_URL", previous.server], ["PI_WEB_SYNC_ALL_CONVERSATIONS", previous.all]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("sync configuration validates URLs and deployment overrides", () => {
  assert.deepEqual(normalizeSyncConfig(undefined), { serverUrl: null, allConversations: false });
  assert.deepEqual(normalizeSyncConfig({ serverUrl: " https://sync.example/ ", allConversations: true }), { serverUrl: "https://sync.example/", allConversations: true });
  assert.throws(() => normalizeSyncConfig({ serverUrl: "ftp://sync.example" }, { strict: true }), error => error.code === "invalid_sync_configuration");

  saveConfig({ sync: { serverUrl: "https://config.example", allConversations: false } });
  process.env.PI_WEB_SYNC_SERVER_URL = "https://environment.example";
  process.env.PI_WEB_SYNC_ALL_CONVERSATIONS = "true";
  assert.deepEqual(syncConfig(loadConfig()), { serverUrl: "https://environment.example", allConversations: true });
  assert.deepEqual(syncSettingsState(loadConfig()), {
    serverUrl: { value: "https://environment.example", source: "PI_WEB_SYNC_SERVER_URL", editable: false },
    allConversations: { value: true, source: "PI_WEB_SYNC_ALL_CONVERSATIONS", editable: false },
  });
  delete process.env.PI_WEB_SYNC_SERVER_URL;
  delete process.env.PI_WEB_SYNC_ALL_CONVERSATIONS;
});

test("enrollment markers are atomic and only track IDs", () => {
  assert.deepEqual(loadSyncSessions(), { version: 1, enrolled: [], pending: [] });
  markSyncPending("s-pending");
  assert.equal(fs.existsSync(syncSessionsPath()), true);
  markSyncEnrolled("s-enrolled");
  markSyncEnrolled("s-enrolled");
  assert.equal(isSyncEnrolled("s-enrolled"), true);
  assert.deepEqual(loadSyncSessions(), { version: 1, enrolled: ["s-enrolled"], pending: ["s-pending"] });
  const raw = fs.readFileSync(syncSessionsPath(), "utf8");
  assert.doesNotMatch(raw, /token|secret|etag/i);
});

test("fake coordinator is idempotent and keeps lease state behind its boundary", async () => {
  const records = [{ id: "u1", role: "user", text: "hello" }];
  const supervisor = {
    async meta(id) { return id === "s1" ? { id, cwd: "/tmp/workspace" } : null; },
    async transcript() { return records; },
    isStreaming() { return false; },
    isCompacting() { return false; },
  };
  const coordinator = new FakeSyncCoordinator({ supervisor, config: { sync: { serverUrl: "https://fake.example", allConversations: false } } });
  assert.equal(coordinator.state().connection, "available");
  assert.equal(coordinator.status("s1").syncState, "pending");
  const first = await coordinator.enroll("s1");
  const second = await coordinator.enroll("s1");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(coordinator.status("s1").synchronized, true);
  const prepared = await coordinator.prepareMutation("s1");
  assert.equal(prepared.token, "fake-lease-s1");
  assert.equal(coordinator.status("s1").syncState, "in_use");
  await coordinator.release("s1");
  assert.equal(coordinator.status("s1").syncState, "available");
});
