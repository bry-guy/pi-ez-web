// SDK drift detector: asserts the API names the real supervisor calls exist in
// the installed @earendil-works/pi-coding-agent — no credentials needed.
import assert from "node:assert/strict";
import { test } from "node:test";

test("pi SDK exposes the surface the real supervisor uses", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  assert.equal(typeof sdk.createAgentSession, "function");
  const SM = sdk.SessionManager;
  assert.equal(typeof SM, "function");
  for (const m of ["create", "open", "list", "forkFrom", "inMemory"]) {
    assert.equal(typeof SM[m], "function", `SessionManager.${m}`);
  }
  const proto = sdk.AgentSession.prototype;
  for (const m of ["prompt", "steer", "followUp", "abort", "subscribe", "setModel", "setSessionName", "dispose", "navigateTree"]) {
    assert.equal(typeof proto[m], "function", `AgentSession.${m}`);
  }
  for (const g of ["sessionId", "sessionFile", "messages", "isStreaming", "isIdle", "sessionName", "model"]) {
    assert.ok(Object.getOwnPropertyDescriptor(proto, g)?.get, `AgentSession getter ${g}`);
  }
});
