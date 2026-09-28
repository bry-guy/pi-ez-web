import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventHub } from "../server/events.js";
import { buildApi } from "../server/routes.js";
import { PiSyncWebAdapter } from "../server/sync/web-adapter.js";

function frames(hub) {
  const values = [];
  hub.addClient(frame => {
    const match = frame.match(/data: (\{.*\})\n/);
    if (match) values.push(JSON.parse(match[1]));
  });
  return values;
}

async function waitFor(values, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = values.find(predicate);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for event");
}

test("web sync commands pass through the native Pi syntax", () => {
  const previous = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = "https://sync.example";
  try {
    const adapter = new PiSyncWebAdapter({ hub: new EventHub(), configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }) });
    assert.equal(adapter.commandText("/sync"), "/sync");
    assert.equal(adapter.commandText("/sync attach"), "/sync attach");
    assert.equal(adapter.commandText("/sync status"), "/sync status");
    assert.equal(adapter.commandText("/sync status https://other.example"), "/sync status https://other.example");
    assert.equal(adapter.commandText("/sync refresh"), "/sync refresh");
    assert.equal(adapter.commandText("/name example"), "/name example");
  } finally {
    if (previous === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previous;
  }
});

test("sync status exposes canonical details without exposing the lease token", async () => {
  const adapter = new PiSyncWebAdapter({
    configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }),
  });
  adapter.bindingStore = async () => ({
    async get() {
      return {
        nativeSessionId: "local-session",
        serverUrl: "https://sync.example",
        canonicalSessionId: "remote-session",
        lastEtag: "e1",
        materializedFile: "/tmp/session.jsonl",
        leaseToken: "secret-token",
        title: "Canonical conversation",
        workspace: { gitRemote: "https://github.com/owner/repo.git", branch: "main", commit: "0123456789abcdef" },
        state: "ready",
      };
    },
  });
  adapter.list = async () => [{
    sessionId: "remote-session",
    title: "Canonical conversation",
    createdAt: "2026-01-01T00:00:00Z",
    headEntryId: "entry-1",
    etag: "e1",
    leaseHolder: "pi-client",
    leaseExpiresAt: "2026-01-01T00:02:00Z",
    workspace: { gitRemote: "https://github.com/owner/repo.git", branch: "main", commit: "0123456789abcdef" },
  }];

  const status = await adapter.status("local-session");
  assert.deepEqual(status, {
    synchronized: true,
    syncSessionId: "remote-session",
    syncTitle: "Canonical conversation",
    syncWorkspace: { gitRemote: "https://github.com/owner/repo.git", branch: "main", commit: "0123456789abcdef" },
    syncState: "in_use",
    leaseHolder: "pi-client",
    leaseExpiresAt: "2026-01-01T00:02:00Z",
  });
  assert.equal("leaseToken" in status, false);
  assert.equal(await adapter.stickyName("local-session"), "Canonical conversation");
});

test("snapshot tokens survive ordinary appends but reject missing and replaced snapshots", async () => {
  let materializedFile = "/tmp/first.jsonl";
  let etag = "e1";
  const adapter = new PiSyncWebAdapter({ configProvider: () => ({ sync: { serverUrl: "https://sync.example" } }) });
  adapter.bindingStore = async () => ({ get: async () => ({ materializedFile, lastEtag: etag }) });
  const first = await adapter.snapshotToken("same-id");
  assert.match(first, /^[a-f0-9]{64}$/);
  etag = "e2";
  assert.equal(await adapter.snapshotToken("same-id"), first);
  materializedFile = "/tmp/replacement.jsonl";
  assert.notEqual(await adapter.snapshotToken("same-id"), first);
  await assert.rejects(adapter.assertSnapshot("same-id", first), error => error.code === "sync_snapshot_stale");
  await assert.rejects(adapter.assertSnapshot("same-id", undefined), error => error.code === "sync_snapshot_stale");
  const latest = await adapter.snapshotToken("same-id");
  await assert.rejects(adapter.assertSnapshot("same-id", latest, "/tmp/first.jsonl"), error => error.code === "sync_snapshot_stale");
});

test("automatic check forwards the native outcome without using manual refresh", async () => {
  const commands = [];
  const adapter = new PiSyncWebAdapter({
    supervisor: {
      async trySyncOperation(_id, task) { return task(); },
      async command(id, text) { commands.push([id, text]); return { outcome: "refreshed", sessionId: id }; },
    },
    configProvider: () => ({ sync: { serverUrl: "https://sync.example" } }),
  });
  adapter.extensionPath = async () => "/tmp/sync.js";
  adapter.snapshotToken = async () => "opaque-token";
  assert.deepEqual(await adapter.autoCheck("same-id"), { outcome: "refreshed", sessionId: "same-id", snapshotToken: "opaque-token" });
  assert.deepEqual(commands, [["same-id", "/sync auto-check"]]);
  adapter.supervisor.command = async () => ({ action: "handled" });
  await assert.rejects(adapter.autoCheck("same-id"), error => error.code === "sync_client_unavailable");
});

test("blank synchronized titles do not block the first local name", async () => {
  const adapter = new PiSyncWebAdapter({
    configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }),
  });
  adapter.bindingStore = async () => ({
    async get() {
      return { nativeSessionId: "local-session", canonicalSessionId: "remote-session", title: "", serverUrl: "https://sync.example", lastEtag: "e1", materializedFile: "/tmp/session.jsonl" };
    },
  });
  assert.equal(await adapter.stickyName("local-session"), undefined);
});

test("beforePrompt delegates stale-session reconciliation to the extension", async () => {
  const previous = { sessionFile: "/tmp/old.jsonl" };
  const current = { sessionFile: "/tmp/new.jsonl" };
  const supervisor = {
    live: new Map([["local-session", { session: previous }]]),
    async command(id, text) {
      assert.equal(id, "local-session");
      assert.equal(text, "/sync reconcile");
      this.live.set(id, { session: current });
    },
  };
  const adapter = new PiSyncWebAdapter({
    supervisor,
    configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }),
  });
  assert.deepEqual(await adapter.beforePrompt("local-session"), { switched: true, sessionId: "local-session" });
});

test("browser enrollment passes the configured server URL to /sync attach", async () => {
  const commands = [];
  let statusCalls = 0;
  const adapter = new PiSyncWebAdapter({
    supervisor: { command: async (...args) => commands.push(args) },
    configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }),
  });
  adapter.extensionPath = async () => "/tmp/sync-extension.js";
  adapter.status = async () => ({ synchronized: statusCalls++ > 0 });

  const result = await adapter.enroll("session-attach");
  assert.deepEqual(commands, [["session-attach", "/sync attach https://sync.example"]]);
  assert.equal(result.created, true);
});

test("browser extension UI resolves select and confirm requests", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new PiSyncWebAdapter({ hub });
  const ui = adapter.uiContext("session-1");

  const selected = ui.select("Choose", ["one", "two"]);
  const selectEvent = await waitFor(events, event => event.type === "extension_ui_request" && event.method === "select");
  assert.deepEqual(selectEvent.options, ["one", "two"]);
  assert.throws(() => adapter.respond("session-1", selectEvent.requestId, { value: "three" }), error => error.code === "invalid_extension_ui_response");
  assert.deepEqual(adapter.respond("session-1", selectEvent.requestId, { value: "two" }), { ok: true });
  assert.equal(await selected, "two");

  const confirmed = ui.confirm("Continue", "Proceed?");
  const confirmEvent = await waitFor(events, event => event.type === "extension_ui_request" && event.method === "confirm");
  assert.throws(() => adapter.respond("session-1", confirmEvent.requestId, { value: "wrong" }), error => error.code === "invalid_extension_ui_response");
  assert.deepEqual(adapter.respond("session-1", confirmEvent.requestId, { confirmed: true }), { ok: true });
  assert.equal(await confirmed, true);
});

test("browser extension UI responses are exposed through the session API", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new PiSyncWebAdapter({ hub });
  const api = buildApi({ setSyncAdapter() {} }, { syncAdapter: adapter });
  const selected = adapter.uiContext("session-3").select("Choose", ["one"]);
  const event = await waitFor(events, value => value.type === "extension_ui_request");
  const response = await api.request(`http://pi-web.test/sessions/session-3/extension-ui/${event.requestId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "one" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(await selected, "one");
});

test("web command errors preserve synchronization HTTP status", async () => {
  const failure = Object.assign(new Error("The synchronized session is in use by another client."), { code: "active_lease" });
  const adapter = {
    withMutation: (_sessionId, task) => task(),
    state: () => ({ version: 1 }),
    commandText: text => text,
  };
  const supervisor = {
    command: async () => { throw failure; },
  };
  const api = buildApi(supervisor, { syncAdapter: adapter });
  const response = await api.request("http://pi-web.test/sessions/session-4/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "/sync refresh" }),
  });
  assert.equal(response.status, 423);
  assert.equal((await response.json()).error, "active_lease");
});

test("automatic-check route stays separate from manual refresh and rejects stale writes", async () => {
  let snapshot = "first";
  let messages = 0;
  const adapter = {
    withMutation: (_id, task) => task(),
    state: () => ({ version: 1 }),
    snapshotToken: async () => snapshot,
    assertSnapshot: async (_id, expected) => {
      if (expected !== snapshot) throw Object.assign(new Error("stale"), { code: "sync_snapshot_stale" });
    },
    autoCheck: async () => ({ outcome: "unchanged", snapshotToken: snapshot }),
  };
  const supervisor = {
    meta: async () => ({ id: "same-id" }),
    setSyncAdapter() {},
    withSyncOperation: async (_id, task) => task(),
    isStreaming: () => false,
    isCompacting: () => false,
    transcript: async () => [{ id: "one", role: "user", text: "old" }],
    message: async () => { messages++; },
  };
  const api = buildApi(supervisor, { syncAdapter: adapter });
  const url = "http://pi-web.test/sessions/same-id";
  const check = await api.request(`${url}/sync/check`, { method: "POST" });
  assert.deepEqual(await check.json(), { outcome: "unchanged", snapshotToken: "first" });
  const transcript = await api.request(`${url}/transcript`);
  assert.equal((await transcript.json()).snapshotToken, "first");
  snapshot = "second";
  const response = await api.request(`${url}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "my draft", snapshotToken: "first" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "sync_snapshot_stale");
  assert.equal(messages, 0);
});

test("bang rejection happens before any command runs", async () => {
  const adapter = {
    withMutation: (_id, task) => task(),
    state: () => ({}),
    assertSnapshot: async () => { throw Object.assign(new Error("stale"), { code: "sync_snapshot_stale" }); },
  };
  const supervisor = {
    setSyncAdapter() {},
    withSyncOperation: async (_id, task) => task(),
    meta: async () => ({ id: "same-id" }),
    bangRecord: async () => { throw new Error("must not persist"); },
  };
  const api = buildApi(supervisor, { syncAdapter: adapter });
  const response = await api.request("http://pi-web.test/sessions/same-id/bang", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "exit 7", snapshotToken: "old" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "sync_snapshot_stale");
});

test("automatic refresh remains busy until bang persistence completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "piweb-bang-refresh-"));
  let recording;
  let complete;
  const started = new Promise(resolve => { recording = resolve; });
  const finish = new Promise(resolve => { complete = resolve; });
  let busy = false;
  const supervisor = {
    setSyncAdapter() {},
    meta: async () => ({ cwd }),
    sessionFile: async () => "/session.jsonl",
    withSyncOperation: async (_id, task) => {
      if (busy) throw Object.assign(new Error("busy"), { code: "sync_busy" });
      busy = true;
      try { return await task(); } finally { busy = false; }
    },
    bangRecord: async () => { recording(); await finish; },
  };
  const adapter = { withMutation: (_id, task) => task(), state: () => ({}), assertSnapshot: async () => {} };
  try {
    const api = buildApi(supervisor, { syncAdapter: adapter });
    const request = api.request("http://pi-web.test/sessions/same-id/bang", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "printf hello", snapshotToken: "current" }),
    });
    await started;
    assert.equal(busy, true);
    complete();
    assert.equal((await request).status, 200);
    assert.equal(busy, false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("transcript never labels pre-replacement records with a new snapshot token", async () => {
  const file = "/old.jsonl";
  let bindingFile = file;
  let token = "old";
  const adapter = {
    state: () => ({}),
    snapshotToken: async (_id, actualFile) => {
      if (actualFile !== bindingFile) throw Object.assign(new Error("changing"), { code: "sync_snapshot_stale" });
      return token;
    },
  };
  const supervisor = {
    setSyncAdapter() {},
    sessionFile: async () => file,
    transcript: async () => { bindingFile = "/new.jsonl"; token = "new"; return [{ text: "old data" }]; },
    isStreaming: () => false,
    isCompacting: () => false,
  };
  const api = buildApi(supervisor, { syncAdapter: adapter });
  const response = await api.request("http://pi-web.test/sessions/same-id/transcript");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "sync_snapshot_stale");
});

test("browser extension UI handles an already-aborted dialog signal", async () => {
  const adapter = new PiSyncWebAdapter({ hub: new EventHub() });
  const signal = AbortSignal.abort();
  assert.equal(await adapter.uiContext("session-aborted").select("Choose", ["one"], { signal }), undefined);
});

test("browser extension UI cancellation resolves the Pi-compatible fallback", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new PiSyncWebAdapter({ hub });
  const ui = adapter.uiContext("session-2");
  const selected = ui.select("Choose", ["one"], { timeout: 1000 });
  const event = await waitFor(events, value => value.type === "extension_ui_request");
  assert.deepEqual(adapter.cancel("session-2", event.requestId), { ok: true, cancelled: true });
  assert.equal(await selected, undefined);
});
