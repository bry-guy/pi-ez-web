#!/usr/bin/env node
// Real-mode smoke: needs ~/.pi/agent (auth + models). Boots the server in real
// mode, runs a plain-chat turn, then a project turn that should produce an
// edit, and asserts the wire contract + snapshot mapping against real pi.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-"));
process.env.PI_WEB_HOME = path.join(tmp, "home");
delete process.env.PI_WEB_MODE; // real

const { startServer } = await import("../server/index.js");
const { server } = startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const J = { "content-type": "application/json" };
const post = (p, b) => fetch(base + p, { method: "POST", headers: J, body: JSON.stringify(b ?? {}) });

const events = [];
fetch(base + "/api/events").then(async res => {
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await rd.read().catch(() => ({ done: true }));
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) >= 0) {
      const f = buf.slice(0, i); buf = buf.slice(i + 2);
      const d = f.split("\n").find(l => l.startsWith("data: "));
      if (d) { try { events.push(JSON.parse(d.slice(6))); } catch {} }
    }
  }
});
const waitFor = async (pred, ms = 120000) => {
  const t0 = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for event");
    await new Promise(r => setTimeout(r, 100));
  }
};
const fail = m => { console.error("✗ " + m); process.exit(1); };
const ok = m => console.log("✓ " + m);

try {
  // 1. plain chat turn
  const { id } = await (await post("/api/chats")).json();
  if (!id) fail("chat creation");
  ok("chat created " + id);
  await post(`/api/sessions/${id}/message`, { text: "Reply with exactly: PI_WEB_OK" });
  await waitFor(e => e.sessionId === id && e.type === "turn_start");
  await waitFor(e => e.sessionId === id && e.type === "text_delta");
  await waitFor(e => e.sessionId === id && e.type === "turn_end");
  ok("turn lifecycle over SSE");
  const snap = await (await fetch(`${base}/api/sessions/${id}/transcript`)).json();
  const text = snap.records.filter(r => r.role === "assistant").map(r => r.text).join("");
  if (!/PI_WEB_OK/.test(text)) fail("snapshot text mismatch: " + JSON.stringify(snap.records));
  ok("snapshot matches streamed turn");

  // 2. project turn with an edit
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo });
  git("init", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello world\n");
  git("add", "-A"); git("commit", "-m", "init");
  const pr = await (await post("/api/projects", { repoPath: repo })).json();
  ok("project created, session " + pr.sessionId);
  await post(`/api/sessions/${pr.sessionId}/message`, { text: "Edit hello.txt so it says 'hello pi' instead of 'hello world'. Use the edit tool." });
  await waitFor(e => e.sessionId === pr.sessionId && e.type === "tool_start", 180000);
  ok("tool_start observed");
  await waitFor(e => e.sessionId === pr.sessionId && e.type === "turn_end", 180000);
  const edited = fs.readFileSync(path.join(repo, "hello.txt"), "utf8");
  if (!/hello pi/.test(edited)) fail("edit did not land: " + edited);
  ok("agent edited the workspace file");
  const sawDiff = events.some(e => e.sessionId === pr.sessionId && e.type === "diff");
  console.log(sawDiff ? "✓ diff event emitted" : "⚠ no diff event (tool result shape not hunk-parseable — plain tool_end fallback held)");

  console.log("\nverify:real PASSED");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
