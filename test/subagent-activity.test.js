import assert from "node:assert/strict";
import test from "node:test";
import subagentTelemetry from "../server/extensions/subagent-telemetry.js";
import {
  SubagentActivityStore,
  normalizeSubagentActivity,
  redactSubagentText,
} from "../server/subagent-activity.js";

class FakeEvents {
  constructor() { this.handlers = new Map(); }
  on(channel, handler) {
    this.handlers.set(channel, handler);
    return () => this.handlers.delete(channel);
  }
  emit(channel, data) { this.handlers.get(channel)?.(data); }
}

function bridgeFixture() {
  const events = new FakeEvents();
  const lifecycle = new Map();
  const entries = [];
  const pi = {
    events,
    on(name, handler) { lifecycle.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  };
  subagentTelemetry(pi);
  return { events, lifecycle, entries };
}

test("subagent records are bounded, redacted, and identity-stable", () => {
  const record = normalizeSubagentActivity({
    id: "agent-1", description: "Inspect", status: "running",
    activity: "reading files", toolUses: 2,
    summary: "Bearer secret https://example.test/?token=abc",
    parentMessageId: "assistant-1", groupId: "group-1", revision: 4,
  });
  assert.equal(record.id, "activity:agent:agent-1");
  assert.equal(record.runId, "agent-1");
  assert.equal(record.status, "running");
  assert.equal(record.parentMessageId, "assistant-1");
  assert.equal(record.groupId, "group-1");
  assert.equal(record.toolCount, 2);
  assert.equal(record.summary, ""); // summaries are terminal-only
  assert.equal(redactSubagentText("Bearer abc sk-secret ghp_token"), "Bearer [redacted] sk-[redacted] gh_[redacted]");
});

test("activity store replaces progress, rejects regressions, and preserves terminal cards", () => {
  const store = new SubagentActivityStore();
  assert.equal(store.apply({
    runId: "agent-1", description: "Explore", status: "queued", revision: 1,
    parentMessageId: "assistant-1", createdAt: "2026-01-01T00:00:00Z",
  }).status, "queued");
  assert.equal(store.apply({
    runId: "agent-1", description: "Explore", status: "running", revision: 2,
    activity: "searching", parentMessageId: "assistant-1", createdAt: "2026-01-01T00:00:00Z",
  }).status, "running");
  assert.equal(store.apply({
    runId: "agent-1", description: "Explore", status: "queued", revision: 3,
    parentMessageId: "assistant-1",
  }), null);
  const done = store.apply({
    runId: "agent-1", description: "Explore", status: "completed", revision: 4,
    summary: "Found it.", parentMessageId: "assistant-1", createdAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(done.status, "completed");
  assert.equal(store.apply({
    runId: "agent-1", description: "Explore", status: "running", revision: 5,
    activity: "late update", parentMessageId: "assistant-1",
  }), null);
  assert.deepEqual(store.snapshot().map(record => [record.runId, record.status, record.summary]), [["agent-1", "completed", "Found it."]]);
});

test("event ingestion owns sparse ordering and terminal state", () => {
  const store = new SubagentActivityStore();
  assert.equal(store.applyEvent("created", { id: "agent-ordered", description: "Search" }).status, "queued");
  assert.equal(store.applyEvent("started", { id: "agent-ordered", activity: "reading" }).status, "running");
  assert.equal(store.applyEvent("completed", { id: "agent-ordered", result: "Done" }).status, "completed");
  assert.equal(store.applyEvent("progress", { id: "agent-ordered", activity: "late" }), null);
  assert.equal(store.applyEvent("failed", { id: "agent-ordered", error: "late failure" }), null);
  assert.equal(store.snapshot()[0].revision, 3);
});

test("headless bridge persists lifecycle events without exposing raw output", () => {
  const { events, lifecycle, entries } = bridgeFixture();
  lifecycle.get("tool_execution_start")?.({}, { sessionManager: { getLeafId: () => "assistant-parent" } });
  events.emit("subagents:created", { id: "agent-2", description: "Search", isBackground: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, "pi-web:subagent");
  assert.equal(entries[0].data.status, "queued");
  assert.equal(entries[0].data.parentMessageId, "assistant-parent");
  events.emit("subagents:started", { id: "agent-2", description: "Search", activity: "reading files" });
  events.emit("subagents:progress", { id: "agent-2", description: "Search", activity: "reading files", toolUses: 1 });
  // A progress event in the same coalescing window is intentionally dropped.
  events.emit("subagents:progress", { id: "agent-2", description: "Search", activity: "Bearer hidden" });
  events.emit("subagents:completed", {
    id: "agent-2", description: "Search", result: "Found Bearer token=secret",
  });
  const final = entries.at(-1).data;
  assert.equal(final.status, "completed");
  assert.match(final.summary, /Bearer \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(entries), /secret/);
  const beforeLateProgress = entries.length;
  events.emit("subagents:progress", { id: "agent-2", activity: "late" });
  assert.equal(entries.length, beforeLateProgress);
  assert.ok(entries.every(entry => entry.customType === "pi-web:subagent"));
});

test("bridge ignores nested agents and unknown channels", () => {
  const { events, entries } = bridgeFixture();
  events.emit("subagents:created", { id: "nested", parentAgentId: "parent", description: "Nested" });
  events.emit("not-subagents", { id: "unknown", description: "Unknown" });
  assert.equal(entries.length, 0);
});
