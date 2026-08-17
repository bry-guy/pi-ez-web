import assert from "node:assert/strict";
import test from "node:test";
import { activityFromEntry, activityFromToolResult, normalizeActivity } from "../server/activity.js";
import { entriesToRecords } from "../server/supervisor/real.js";

test("todo tool details become a bounded activity record", () => {
  const record = activityFromToolResult({
    details: {
      tasks: [
        { id: 1, subject: "Inspect", status: "completed" },
        { id: 2, subject: "<render>", status: "in_progress", activeForm: "rendering" },
      ],
      nextId: 3,
    },
  }, "tc-1");
  assert.deepEqual(record, {
    id: "activity:todo:tc-1",
    role: "activity",
    kind: "todo",
    key: "todo",
    status: "in_progress",
    title: "Todos",
    summary: "1/2 complete · 1 active",
    items: [
      { id: "1", subject: "Inspect", description: "", status: "completed", activeForm: "", blockedBy: [] },
      { id: "2", subject: "<render>", description: "", status: "in_progress", activeForm: "rendering", blockedBy: [] },
    ],
    source: "pi",
  });
});

test("custom subagent entries become durable activity records", () => {
  const record = activityFromEntry({
    type: "custom_message",
    id: "entry-1",
    customType: "subagent-notification",
    content: "ignored fallback",
    details: { id: "agent-7", description: "Explore", status: "completed", resultPreview: "Found the files." },
  });
  assert.equal(record.role, "activity");
  assert.equal(record.kind, "agent");
  assert.equal(record.key, "agent:agent-7");
  assert.equal(record.summary, "Found the files.");
});

test("activity is recovered beside ordinary transcript records", () => {
  const records = entriesToRecords([
    { type: "message", id: "assistant", parentId: "user", timestamp: "now", message: {
      role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "todo", arguments: {} }],
    } },
    { type: "message", id: "tool", parentId: "assistant", timestamp: "now", message: {
      role: "toolResult", toolCallId: "tc-2", toolName: "todo", content: [{ type: "text", text: "Updated" }],
      details: { tasks: [{ id: 1, subject: "Done", status: "completed" }], nextId: 2 },
    } },
    { type: "custom", id: "custom", parentId: "tool", timestamp: "now", customType: "subagents:record",
      data: { id: "agent-1", description: "Explore", status: "completed", result: "Done" } },
  ]);
  assert.deepEqual(records.map(record => record.role), ["tool", "activity", "activity"]);
  assert.equal(records[1].kind, "todo");
  assert.equal(records[2].kind, "agent");
});

test("unknown or oversized activity is rejected", () => {
  assert.equal(normalizeActivity({ id: "x", kind: "unknown", summary: "nope" }), null);
  assert.equal(normalizeActivity({ id: "x", kind: "status", summary: "x".repeat(128_001) }), null);
});
