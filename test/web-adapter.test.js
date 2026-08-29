import assert from "node:assert/strict";
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

test("browser enrollment dispatches /sync attach without an endpoint argument", async () => {
  const commands = [];
  let statusCalls = 0;
  const adapter = new PiSyncWebAdapter({
    supervisor: { command: async (...args) => commands.push(args) },
    configProvider: () => ({ sync: { serverUrl: "https://sync.example", allConversations: false } }),
  });
  adapter.extensionPath = async () => "/tmp/sync-extension.js";
  adapter.status = async () => ({ synchronized: statusCalls++ > 0 });

  const result = await adapter.enroll("session-attach");
  assert.deepEqual(commands, [["session-attach", "/sync attach"]]);
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
