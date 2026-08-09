#!/usr/bin/env node
// Credentialed real-mode acceptance gate. Requires ~/.pi/agent auth/models.
// It validates the supervisor against the real SDK, including entry identity,
// model resolution, cwd recovery, queue delivery, fork rewind, and an edit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-"));
process.env.PI_WEB_HOME = path.join(tmp, "home");
delete process.env.PI_WEB_MODE;

const { startServer } = await import("../server/index.js");
let server;
let base;
let events;
let reader;

const J = { "content-type": "application/json" };
const post = (p, b) => fetch(base + p, { method: "POST", headers: J, body: JSON.stringify(b ?? {}) });
const get = p => fetch(base + p);

async function boot() {
  ({ server } = startServer(0));
  base = `http://127.0.0.1:${server.address().port}`;
  events = [];
  const res = await fetch(base + "/api/events");
  reader = res.body?.getReader();
  if (!reader) throw new Error("SSE connection did not expose a reader");
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split("\n").find(x => x.startsWith("data: "));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
      }
    }
  })();
}
function stopServer() {
  server?.closeAllConnections?.();
  server?.close();
  server = null;
}
async function waitFor(pred, ms = 180000) {
  const started = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - started > ms) throw new Error("timeout waiting for real event");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
function ok(message) { console.log(`✓ ${message}`); }
function fail(message) { throw new Error(message); }
async function turn(id, text, mode) {
  const before = events.length;
  const response = await post(`/api/sessions/${id}/message`, { text, ...(mode ? { mode } : {}) });
  if (!response.ok) fail(`message rejected: ${await response.text()}`);
  const user = await waitFor(e => e.sessionId === id && e.type === "user_record" && e.seq > (events[before - 1]?.seq || 0));
  const start = await waitFor(e => e.sessionId === id && e.type === "turn_start" && e.seq > user.seq);
  await waitFor(e => e.sessionId === id && e.type === "turn_end" && e.seq > start.seq);
  return user;
}

try {
  await boot();
  const models = await (await get("/api/models")).json();
  if (!models.models?.length) fail("real model registry returned no available models");
  ok(`model registry returned ${models.models.length} model(s)`);

  const chat = await (await post("/api/chats")).json();
  if (!chat.id) fail("chat creation");
  await turn(chat.id, "Reply with exactly: PI_WEB_OK");
  const snap1 = await (await get(`/api/sessions/${chat.id}/transcript`)).json();
  const snap2 = await (await get(`/api/sessions/${chat.id}/transcript`)).json();
  if (!/PI_WEB_OK/.test(snap1.records.filter(r => r.role === "assistant").map(r => r.text).join(""))) fail("snapshot text mismatch");
  if (JSON.stringify(snap1.records.map(r => r.id)) !== JSON.stringify(snap2.records.map(r => r.id))) fail("snapshot IDs changed");
  ok("real turn, user_record, snapshot text, and stable IDs");

  const secondModel = models.models[1] || models.models[0];
  const modelResponse = await post(`/api/sessions/${chat.id}/model`, { model: secondModel.id });
  if (!modelResponse.ok) fail(`model change rejected: ${await modelResponse.text()}`);
  const meta = await (await get(`/api/sessions/${chat.id}/meta`)).json();
  if (meta.model !== secondModel.id) fail(`model metadata mismatch: ${meta.model}`);
  ok("real model resolution and session model metadata");

  await post(`/api/sessions/${chat.id}/message`, { text: "Start a response I can queue against." });
  await waitFor(e => e.sessionId === chat.id && e.type === "text_delta");
  const queuedResponse = await post(`/api/sessions/${chat.id}/message`, { text: "queued follow-up", mode: "followUp" });
  if (!queuedResponse.ok) fail(`follow-up rejected: ${await queuedResponse.text()}`);
  const queue = await waitFor(e => e.sessionId === chat.id && e.type === "queue_update" && e.followUp > 0);
  const queuedUser = await waitFor(e => e.sessionId === chat.id && e.type === "user_record" && e.record?.text === "queued follow-up" && e.seq > queue.seq);
  if (!queuedUser) fail("follow-up user_record did not arrive at delivery");
  await waitFor(e => e.sessionId === chat.id && e.type === "turn_end" && e.seq > queuedUser.seq);
  ok("follow-up queue count and delivery ordering");

  // Restart the server and attach to the same chat. The transcript is owned
  // by Pi; the app process and supervisor cache are intentionally discarded.
  const chatCwd = path.join(process.env.PI_WEB_HOME, "chats");
  stopServer();
  await boot();
  const coldMeta = await (await get(`/api/sessions/${chat.id}/meta`)).json();
  if (coldMeta.cwd !== chatCwd) fail(`cold cwd mismatch: ${coldMeta.cwd} != ${chatCwd}`);
  await turn(chat.id, "Reply with exactly: AFTER_RESTART");
  ok("restart attach and message use the recorded cwd");

  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello world\n");
  git("add", "-A"); git("commit", "-m", "init");
  const project = await (await post("/api/projects", { repoPath: repo })).json();
  const projectMeta = await (await get(`/api/sessions/${project.sessionId}/meta`)).json();
  if (projectMeta.cwd !== repo) fail(`project cwd mismatch: ${projectMeta.cwd}`);
  await post(`/api/sessions/${project.sessionId}/message`, { text: "Edit hello.txt so it says 'hello pi' instead of 'hello world'. Use the edit tool." });
  await waitFor(e => e.sessionId === project.sessionId && e.type === "tool_start");
  await waitFor(e => e.sessionId === project.sessionId && e.type === "turn_end");
  if (!/hello pi/.test(fs.readFileSync(path.join(repo, "hello.txt"), "utf8"))) fail("edit did not land");
  ok("real project turn used the project cwd and edited a file");

  git("add", "-A"); git("commit", "-m", "agent edit");
  await turn(project.sessionId, "Reply with exactly: FIRST_FORK_TURN");
  const beforeFork = await (await get(`/api/sessions/${project.sessionId}/transcript`)).json();
  const firstUser = beforeFork.records.find(r => r.role === "user");
  if (!firstUser) fail("no canonical user entry for fork");
  const fork = await (await post(`/api/sessions/${project.sessionId}/fork`, { atRecordId: firstUser.id })).json();
  if (!fork.id) fail(`fork failed: ${JSON.stringify(fork)}`);
  const forkSnap = await (await get(`/api/sessions/${fork.id}/transcript`)).json();
  if (forkSnap.records.some(r => r.role === "user" && r.id === firstUser.id)) fail("fork was not truncated before selected message");
  ok("real fork rewound before the selected user entry");

  console.log("\nverify:real PASSED");
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
}
