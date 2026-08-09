import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToRecords } from "../server/supervisor/real.js";

test("real session entry mapping is stable and preserves custom bang records", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "README.md" } }] } },
    { type: "message", id: "tr1", parentId: "a1", message: { role: "toolResult", toolCallId: "tc1", content: "contents" } },
    { type: "custom", id: "b1", parentId: "tr1", customType: "pi-web:bang", data: { id: "bg1", cmd: "echo ok", meta: "exit 0", out: "ok\n" } },
  ];
  const first = entriesToRecords(entries);
  const second = entriesToRecords(entries);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(r => r.id), ["u1", "a:u1", "tc1", "bg1"]);
  assert.equal(first.find(r => r.id === "tc1").out, "contents");
  assert.equal(first.find(r => r.role === "bang").out, "ok\n");
});
