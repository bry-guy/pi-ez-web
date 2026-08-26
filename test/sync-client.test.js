import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { EventHub } from "../server/events.js";
import { loadSyncSessions } from "../server/sync/enrollment.js";
import { PiSyncCoordinator } from "../server/sync/coordinator.js";

let home;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-sync-client-"));
  process.env.PI_WEB_HOME = home;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function envelope(id, text = "hello") {
  return {
    formatVersion: 1,
    sessionId: id,
    piSessionVersion: 3,
    createdAt: "2026-01-01T00:00:00Z",
    parentSessionId: null,
    headEntryId: "entry-1",
    title: "Test session",
    entries: [{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text } }],
  };
}

function harness(id = "session-1") {
  let local = envelope(id);
  let remote = null;
  let etag = "e1";
  let lease = false;
  let materialized = 0;
  const calls = [];
  const client = {
    async health() { return { status: "ok" }; },
    async list() {
      return { sessions: remote ? [{ sessionId: id, title: remote.title, createdAt: remote.createdAt, headEntryId: remote.headEntryId, etag, leaseHolder: lease ? "other" : null, leaseExpiresAt: null }] : [] };
    },
    async enroll(value) { calls.push(["enroll", value]); remote = value; return { session: value, etag }; },
    async acquire() { calls.push(["acquire"]); lease = true; return { session: remote, etag, lease: { token: "lease-token", holder: "pi-web-test", expiresAt: "2026-01-01T00:02:00Z" } }; },
    async renew() { return { etag, lease: { holder: "pi-web-test", expiresAt: "2026-01-01T00:02:00Z" } }; },
    async update(_id, value, _token, expected) {
      calls.push(["update", value]);
      assert.equal(expected, etag);
      remote = value;
      etag = "e2";
      return { session: value, etag };
    },
    async release() { calls.push(["release"]); lease = false; },
  };
  const supervisor = {
    hub: new EventHub(),
    isStreaming: () => false,
    isCompacting: () => false,
    async syncSessionInfo() { return { id, file: "/tmp/session.jsonl", cwd: home, headEntryId: local.headEntryId, title: local.title, parentSessionId: null }; },
    async prepareSyncSnapshot(_id, value) { calls.push(["materialize"]); local = value; materialized++; },
    sessionIdFromFile: () => null,
  };
  const adapter = {
    async deriveWorkspacePointer() { return undefined; },
    async normalizeSessionFile() { return local; },
    async materializeSessionFile() {},
  };
  const coordinator = new PiSyncCoordinator({
    supervisor,
    config: { sync: { serverUrl: "http://sync.test", allConversations: false } },
    clientFactory: () => client,
    adapter,
    heartbeatMs: 60_000,
    holder: "pi-web-test",
  });
  return { coordinator, client, calls, get local() { return local; }, get remote() { return remote; }, get materialized() { return materialized; }, set local(value) { local = value; } };
}

test("real coordinator enrolls, materializes the canonical snapshot, settles, and releases", async () => {
  const h = harness();
  const enrolled = await h.coordinator.enroll("session-1");
  assert.equal(enrolled.created, true);
  assert.deepEqual(loadSyncSessions().enrolled, ["session-1"]);
  const lease = await h.coordinator.beginMutation("session-1");
  assert.equal(lease.managed, true);
  assert.equal(h.materialized, 1);
  h.local = envelope("session-1", "changed locally");
  await h.coordinator.agentSettled("session-1");
  assert.deepEqual(h.calls.map(call => call[0]), ["enroll", "acquire", "materialize", "update", "release"]);
  assert.equal(h.remote.entries[0].message.content, "changed locally");
  assert.equal((JSON.stringify(loadSyncSessions())).includes("lease-token"), false);
});

test("an expired lease reacquires and uploads a pending settled snapshot when the ETag is unchanged", async () => {
  const h = harness("session-recover");
  await h.coordinator.enroll("session-recover");
  const lease = await h.coordinator.beginMutation("session-recover");
  const active = h.coordinator.active.get("session-recover");
  active.uncertain = true;
  active.leaseError = "lease_invalid";
  active.blocked = { code: "sync_lease_uncertain", message: "expired" };
  h.local = envelope("session-recover", "pending after expiry");
  await assert.rejects(() => h.coordinator.agentSettled("session-recover"), error => error.code === "sync_lease_uncertain");
  const recovered = await h.coordinator.beginMutation("session-recover");
  assert.equal(recovered.managed, true);
  assert.equal(h.remote.entries[0].message.content, "pending after expiry");
  assert.equal(h.coordinator.active.has("session-recover"), true);
  await h.coordinator.release("session-recover");
  assert.equal(lease.managed, true);
});

test("same-process mutations are serialized behind one coordinator lease", async () => {
  const h = harness("session-queue");
  await h.coordinator.enroll("session-queue");
  let running = 0;
  let maximum = 0;
  const task = label => h.coordinator.withMutation("session-queue", async () => {
    running++;
    maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, label === "first" ? 10 : 1));
    running--;
  });
  await Promise.all([task("first"), task("second")]);
  assert.equal(maximum, 1);
  assert.equal(h.coordinator.active.has("session-queue"), false);
});

test("a failed release is retried without stranding the web holder", async () => {
  const h = harness("session-release");
  await h.coordinator.enroll("session-release");
  let failed = true;
  const release = h.client.release;
  h.client.release = async (...args) => {
    if (failed) {
      failed = false;
      const error = new Error("temporary network failure");
      error.code = "network_error";
      throw error;
    }
    return release(...args);
  };
  await h.coordinator.beginMutation("session-release");
  await h.coordinator.release("session-release");
  assert.equal(h.coordinator.active.has("session-release"), true);
  await h.coordinator._heartbeat("session-release", h.coordinator.active.get("session-release"));
  assert.equal(h.coordinator.active.has("session-release"), false);
});

test("refresh materializes the canonical snapshot and releases without settling", async () => {
  const h = harness("session-refresh");
  await h.coordinator.enroll("session-refresh");
  const result = await h.coordinator.refresh("session-refresh");
  assert.equal(result.ok, true);
  assert.equal(h.materialized, 1);
  assert.deepEqual(h.calls.map(call => call[0]), ["enroll", "acquire", "materialize", "release"]);
  assert.equal(h.coordinator.active.has("session-refresh"), false);
});

test("refresh rejects an active lease before materialization", async () => {
  const h = harness("session-refresh-conflict");
  await h.coordinator.enroll("session-refresh-conflict");
  const localBefore = structuredClone(h.local);
  let acquired = false;
  h.client.acquire = async () => {
    acquired = true;
    const error = new Error("safe lease message");
    error.code = "active_lease";
    error.details = { holder: "laptop", expiresAt: "2026-01-01T00:02:00Z", currentEtag: "secret-etag" };
    throw error;
  };
  await assert.rejects(() => h.coordinator.refresh("session-refresh-conflict"), error => {
    assert.equal(error.code, "active_lease");
    assert.equal(error.status, 423);
    return true;
  });
  assert.equal(h.materialized, 0);
  assert.deepEqual(h.local, localBefore);
  assert.equal(acquired, true);
  assert.deepEqual(h.calls.map(call => call[0]), ["enroll"]);
  assert.equal(h.coordinator.active.has("session-refresh-conflict"), false);
});

test("refresh reports an uncertain lease when release fails", async () => {
  const h = harness("session-refresh-release");
  await h.coordinator.enroll("session-refresh-release");
  const release = h.client.release;
  h.client.release = async () => {
    const error = new Error("temporary network failure");
    error.code = "network_error";
    throw error;
  };
  await assert.rejects(() => h.coordinator.refresh("session-refresh-release"), error => error.code === "sync_lease_uncertain");
  assert.equal(h.coordinator.active.has("session-refresh-release"), true);
  h.client.release = release;
  await h.coordinator.release("session-refresh-release");
  assert.equal(h.coordinator.active.has("session-refresh-release"), false);
});

test("an external lease is surfaced without exposing a token or ETag", async () => {
  const h = harness("session-2");
  await h.coordinator.enroll("session-2");
  h.client.acquire = async () => {
    const error = new Error("safe lease message");
    error.code = "active_lease";
    error.details = { holder: "laptop", expiresAt: "2026-01-01T00:02:00Z", currentEtag: "secret-etag" };
    throw error;
  };
  await assert.rejects(() => h.coordinator.prepareMutation("session-2"), error => {
    assert.equal(error.code, "active_lease");
    assert.equal(error.status, 423);
    assert.deepEqual(error.details, { holder: "laptop", expiresAt: "2026-01-01T00:02:00Z" });
    return true;
  });
});
