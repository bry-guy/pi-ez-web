// Integration: boots the app in mock mode on an ephemeral port and drives it
// over HTTP + a raw SSE reader. Asserts the wire contract end-to-end.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as ws from "../server/workspaces.js";
import { chatsDir, loadBindings, loadConfig, saveConfig, sessionSlug } from "../server/config.js";

let base, server, supervisor, home, tmp, repo;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}
const J = { "content-type": "application/json" };
const post = (p, body) => fetch(base + p, { method: "POST", headers: J, body: JSON.stringify(body ?? {}) });
const get = p => fetch(base + p);

// --- raw SSE reader: collects parsed events, awaitable predicates ---
class SSE {
  constructor(url) {
    this.events = [];
    this.waiters = [];
    this.done = fetch(url).then(async res => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split("\n").find(l => l.startsWith("data: "));
          if (!data) continue;
          try {
            const evt = JSON.parse(data.slice(6));
            this.events.push(evt);
            this.waiters = this.waiters.filter(w => !w(evt));
          } catch { /* ignore */ }
        }
      }
    });
  }
  wait(pred, ms = 8000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("SSE wait timeout")), ms);
      this.waiters.push(evt => {
        if (pred(evt)) { clearTimeout(t); resolve(evt); return true; }
        return false;
      });
    });
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-srv-"));
  home = path.join(tmp, "home");
  const reposRoot = path.join(tmp, "local-repositories");
  repo = path.join(reposRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ reposRoot, worktreeRoot: path.join(home, "worktrees") }));
  delete process.env.PI_WEB_REPOS_ROOT;
  process.env.PI_WEB_HOME = home;
  process.env.PI_WEB_MODE = "mock";
  process.env.PI_WEB_MOCK_THINK_MS = "120";
  process.env.PI_WEB_MOCK_DELTA_MS = "5";

  const { startServer } = await import("../server/index.js");
  ({ server, sup: supervisor } = startServer(0));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => {
  server?.closeAllConnections?.();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("serves the UI", async () => {
  const html = await (await get("/")).text();
  assert.match(html, /<pi-app>/);
  const css = await (await get("/app.css")).text();
  assert.match(css, /--pi-orange/);
  // Custom elements default to display:inline; without this rule the sidebar,
  // header, composer, and file panel are not flex items and collapse.
  assert.match(css, /pi-sidebar[\s\S]{0,200}display:\s*contents/);
});

test("repository picker uses the configured local repositories root", async () => {
  const state = await (await get("/api/state")).json();
  assert.equal(state.reposRoot, path.resolve(tmp, "local-repositories"));
  assert.equal(state.reposRootSource, "config");
  const repos = await (await get("/api/repos")).json();
  assert.equal(repos.root, state.reposRoot);
  assert.deepEqual(repos.repos, [{ path: repo, name: "repo" }]);
});

test("plain chats use isolated scratch workspaces and retain legacy discovery", async () => {
  const sse = new SSE(base + "/api/events");
  const a = await (await post("/api/chats")).json();
  const b = await (await post("/api/chats")).json();
  const metaA = await (await get(`/api/sessions/${a.id}/meta`)).json();
  const metaB = await (await get(`/api/sessions/${b.id}/meta`)).json();
  const chatRoot = path.resolve(chatsDir());
  assert.notEqual(metaA.cwd, metaB.cwd);
  for (const cwd of [metaA.cwd, metaB.cwd]) {
    assert.ok(fs.existsSync(cwd));
    assert.ok(path.relative(chatRoot, cwd) && !path.relative(chatRoot, cwd).startsWith(".."));
  }

  let state = await (await get("/api/state")).json();
  assert.ok(state.chats.some(chat => chat.id === a.id));
  assert.ok(state.chats.some(chat => chat.id === b.id));

  const legacy = await supervisor.createSession({ cwd: chatsDir() });
  state = await (await get("/api/state")).json();
  assert.ok(state.chats.some(chat => chat.id === legacy.id));

  await post(`/api/sessions/${b.id}/message`, { text: "stream in chat B" });
  await sse.wait(e => e.sessionId === b.id && e.type === "message_start");
  const aResponse = await post(`/api/sessions/${a.id}/message`, { text: "chat A is independent" });
  assert.equal(aResponse.status, 200);
  await sse.wait(e => e.sessionId === a.id && e.type === "turn_end");
  await sse.wait(e => e.sessionId === b.id && e.type === "turn_end");

  const branchResponse = await post(`/api/sessions/${a.id}/branch`, { branch: "not-a-chat-branch", create: true });
  assert.equal(branchResponse.status, 404);
  assert.equal((await branchResponse.json()).error, "no_project_for_session");
  const forkResponse = await post(`/api/sessions/${b.id}/fork`, {});
  assert.equal(forkResponse.status, 400);
  assert.equal((await forkResponse.json()).error, "fork_requires_project");
  const mergeResponse = await post(`/api/sessions/${b.id}/merge`, {});
  assert.equal(mergeResponse.status, 404);
  assert.equal((await mergeResponse.json()).error, "no_project_for_session");

  await post(`/api/sessions/${a.id}/bang`, { cmd: "pwd" });
  const bang = await sse.wait(e => e.sessionId === a.id && e.type === "bang_end");
  assert.equal(fs.realpathSync(bang.stdout.trim()), fs.realpathSync(metaA.cwd));

  const closeResponse = await post(`/api/sessions/${a.id}/close`, {});
  assert.equal(closeResponse.status, 200);
  assert.ok(fs.existsSync(metaA.cwd));
  state = await (await get("/api/state")).json();
  assert.ok(!state.chats.some(chat => chat.id === a.id));
});

test("plain chat: full turn lifecycle over SSE (thinking -> deltas -> done)", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  assert.ok(id);
  const models = await (await get("/api/models")).json();
  assert.deepEqual(models.models.map(m => m.id), ["mock/fast", "mock/smart"]);

  await post(`/api/sessions/${id}/message`, { text: "hello there" });
  const ur = await sse.wait(e => e.sessionId === id && e.type === "user_record");
  assert.equal(ur.record.text, "hello there");
  const ts = await sse.wait(e => e.sessionId === id && e.type === "turn_start");
  assert.ok(ts.turnId);
  assert.equal(sse.events.filter(e => e.sessionId === id && e.type === "user_record").length, 1);
  const ms = await sse.wait(e => e.sessionId === id && e.type === "message_start");
  assert.equal(ms.role, "assistant");
  // thinking gap: no text_delta may precede message_start
  const firstDelta = await sse.wait(e => e.sessionId === id && e.type === "text_delta");
  assert.ok(firstDelta.seq > ms.seq);
  const te = await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  assert.equal(te.reason, "done");

  // snapshot equals streamed result
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.equal(snap.streaming, false);
  assert.equal(typeof snap.seq, "number");
  const roles = snap.records.map(r => r.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  const streamedText = sse.events.filter(e => e.sessionId === id && e.type === "text_delta").map(e => e.delta).join("");
  assert.equal(snap.records[1].text, streamedText);
});

test("stop during thinking removes the empty assistant turn", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "slow one" });
  await sse.wait(e => e.sessionId === id && e.type === "message_start");
  await post(`/api/sessions/${id}/stop`);
  const te = await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  assert.equal(te.reason, "stopped");
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.deepEqual(snap.records.map(r => r.role), ["user"]); // empty assistant removed
});

test("tool + diff events produce structured records", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "please edit the sessions file" });
  const tool = await sse.wait(e => e.sessionId === id && e.type === "tool_start");
  assert.equal(tool.name, "grep");
  await sse.wait(e => e.sessionId === id && e.type === "tool_end" && e.ok);
  const diff = await sse.wait(e => e.sessionId === id && e.type === "diff");
  assert.ok(diff.hunks[0].lines.some(l => l.sign === "+"));
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.deepEqual(snap.records.map(r => r.role), ["user", "tool", "diff", "assistant"]);
});

test("followUp queues; steer interrupts", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "first prompt" });
  await sse.wait(e => e.sessionId === id && e.type === "text_delta");
  await post(`/api/sessions/${id}/message`, { text: "queued follow-up", mode: "followUp" });
  await sse.wait(e => e.sessionId === id && e.type === "queue_update");
  // first turn ends, queued follow-up starts a second turn automatically
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  const ur2 = await sse.wait(e => e.sessionId === id && e.type === "user_record" && e.record?.text === "queued follow-up");
  assert.ok(ur2);
  const ts2 = await sse.wait(e => e.sessionId === id && e.type === "turn_start" && e.seq > ur2.seq);
  // steer the second turn
  await sse.wait(e => e.sessionId === id && e.type === "text_delta" && e.seq > ts2.seq);
  await post(`/api/sessions/${id}/message`, { text: "actually do this", mode: "steer" });
  const ur3 = await sse.wait(e => e.sessionId === id && e.type === "user_record" && e.record?.text === "actually do this");
  assert.ok(ur3);
  const ts3 = await sse.wait(e => e.sessionId === id && e.type === "turn_start" && e.seq > ur3.seq);
  await sse.wait(e => e.sessionId === id && e.type === "turn_end" && e.seq > ts3.seq);
});

test("bang runs in the workspace and lands in the transcript", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/bang`, { cmd: "echo bang-ok" });
  const be = await sse.wait(e => e.sessionId === id && e.type === "bang_end");
  assert.equal(be.exit, 0);
  assert.match(be.stdout, /bang-ok/);
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  const bang = snap.records.find(r => r.role === "bang");
  assert.ok(bang && /bang-ok/.test(bang.out));
});

let projectId, firstSessionId;
test("project creation: first session on the checkout branch", async () => {
  const res = await (await post("/api/projects", { repoPath: repo })).json();
  projectId = res.id;
  firstSessionId = res.sessionId;
  assert.ok(projectId && firstSessionId);
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.equal(p.branch, "main");
  assert.equal(p.occupied.main.sessionId, firstSessionId);
  assert.equal(p.sessions[0].id, firstSessionId);
  assert.equal(p.sessions[0].branch, "main");
  assert.equal(p.sessions[0].model, "mock/fast");
});

test("dirty checkout fork is refused without stashing the checkout", async () => {
  const marker = path.join(repo, "local-only.txt");
  fs.writeFileSync(marker, "keep me\n");
  const r = await post(`/api/sessions/${firstSessionId}/fork`, {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "checkout_dirty");
  assert.equal(fs.readFileSync(marker, "utf8"), "keep me\n");
  fs.rmSync(marker);
});

test("branch create re-homes the session to a new worktree", async () => {
  const r = await post(`/api/sessions/${firstSessionId}/branch`, { branch: "feat/json", create: true });
  assert.equal(r.status, 200);
  const { workspacePath } = await r.json();
  assert.ok(fs.existsSync(path.join(workspacePath, "README.md")));
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.equal(p.sessions[0].branch, "feat/json");
  assert.equal(p.occupied["feat/json"].sessionId, firstSessionId);
  assert.equal(p.occupied.main, undefined); // main is free again
});

test("project state exposes streaming and bang respects the workspace lock", async () => {
  const sse = new SSE(base + "/api/events");
  const a = await supervisor.createSession({ cwd: repo });
  const a2 = await supervisor.createSession({ cwd: repo });
  await post(`/api/sessions/${a.id}/message`, { text: "lock owner" });
  await sse.wait(e => e.sessionId === a.id && e.type === "message_start");

  let state = await (await get("/api/state")).json();
  const project = state.projects.find(p => p.id === projectId);
  const node = project.sessions.find(s => s.id === a.id);
  const sibling = project.sessions.find(s => s.id === a2.id);
  assert.equal(node.streaming, true);
  assert.equal(sibling.streaming, false);

  const busyBang = await post(`/api/sessions/${a2.id}/bang`, { cmd: "pwd" });
  assert.equal(busyBang.status, 409);
  assert.equal((await busyBang.json()).error, "workspace_busy");
  await sse.wait(e => e.sessionId === a.id && e.type === "turn_end");

  const freeBang = await post(`/api/sessions/${a2.id}/bang`, { cmd: "pwd" });
  assert.equal(freeBang.status, 200);
  await sse.wait(e => e.sessionId === a2.id && e.type === "bang_end");
  state = await (await get("/api/state")).json();
  const refreshed = state.projects.find(p => p.id === projectId);
  assert.equal(refreshed.sessions.find(s => s.id === a.id).streaming, false);
});

test("occupied branch blocks another session moving onto it (409 branch_occupied)", async () => {
  // second session in this project: create on main (free), then try to move onto feat/json
  const { id: s2 } = await (await post("/api/chats")).json(); // plain chat first…
  // …no: create a real project session by re-homing a chat is not the shape; use the project checkout:
  // simulate an externally created session bound to the checkout:
  const res = await post(`/api/sessions/${s2}/branch`, { branch: "feat/json", create: false });
  // s2 is a plain chat with no project — expect 404 no_project_for_session
  assert.equal(res.status, 404);

  // proper second project session: fork the first one, then try to move the fork onto feat/json
  const fr = await (await post(`/api/sessions/${firstSessionId}/fork`, {})).json();
  assert.ok(fr.id && fr.branch.startsWith("branch/"));
  const mv = await post(`/api/sessions/${fr.id}/branch`, { branch: "feat/json" });
  assert.equal(mv.status, 409);
  const body = await mv.json();
  assert.equal(body.error, "branch_occupied");
  assert.equal(body.bySessionId, firstSessionId);
});

test("fork carries dirty workspace state point-in-time", async () => {
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  const parentWs = p.worktrees["feat/json"];
  fs.writeFileSync(path.join(parentWs, "dirty.txt"), "uncommitted\n");

  const sse = new SSE(base + "/api/events");
  const fr = await (await post(`/api/sessions/${firstSessionId}/fork`, {})).json();
  assert.ok(fs.existsSync(path.join(fr.workspacePath, "dirty.txt"))); // fork has it
  assert.ok(fs.existsSync(path.join(parentWs, "dirty.txt")));          // parent keeps it
  await sse.wait(e => e.type === "session_forked" && e.sessionId === fr.id);
  // forked session is bound to its own fresh branch — occupied maps update
  const st2 = await (await get("/api/state")).json();
  const p2 = st2.projects.find(x => x.id === projectId);
  assert.equal(p2.occupied[fr.branch].sessionId, fr.id);
});

test("fork transcript truncates at the forked message and seeds lineage", async () => {
  // give the first session a turn so there's something to fork at
  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${firstSessionId}/message`, { text: "turn one" });
  await sse.wait(e => e.sessionId === firstSessionId && e.type === "turn_end");
  await post(`/api/sessions/${firstSessionId}/message`, { text: "turn two" });
  await sse.wait(e => e.sessionId === firstSessionId && e.type === "turn_end" && sse.events.filter(x => x.sessionId === firstSessionId && x.type === "turn_end").length >= 2);

  const snap = await (await get(`/api/sessions/${firstSessionId}/transcript`)).json();
  const secondUser = snap.records.filter(r => r.role === "user")[1];
  const fr = await (await post(`/api/sessions/${firstSessionId}/fork`, { atRecordId: secondUser.id })).json();
  const forkSnap = await (await get(`/api/sessions/${fr.id}/transcript`)).json();
  const users = forkSnap.records.filter(r => r.role === "user").map(r => r.text);
  assert.deepEqual(users, ["turn one"]); // truncated before "turn two"

  const st = await (await get("/api/state")).json();
  const p = st.projects.find(x => x.id === projectId);
  const parentNode = JSON.stringify(p.sessions);
  assert.match(parentNode, new RegExp(fr.id)); // fork appears in the tree
});

test("workspace_busy backstop: two sessions sharing a cwd cannot both run turns", async () => {
  // Simulate an externally created second session in the same workspace (pi CLI style):
  const st = await (await get("/api/state")).json();
  const p = st.projects.find(x => x.id === projectId);
  const wsPath = p.worktrees["feat/json"];
  // create a mock session directly in that cwd via the chats endpoint trick is wrong;
  // use supervisor storage shape: easiest honest path is the API — a fork lands in
  // its own worktree, so instead re-home a fresh fork onto a NEW branch, then
  // hand-bind it to feat/json by writing bindings.json like an external tool would.
  const fr = await (await post(`/api/sessions/${firstSessionId}/fork`, {})).json();
  const bindingsPath = path.join(home, "bindings.json");
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, "utf8").trim() || "{}");
  bindings[fr.id] = { branch: "feat/json", workspacePath: wsPath };
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings));
  // also point the mock session's cwd there (external creation would have done this)
  const mockFile = path.join(home, "mock-sessions", fr.id + ".json");
  const mock = JSON.parse(fs.readFileSync(mockFile, "utf8"));
  mock.cwd = wsPath;
  fs.writeFileSync(mockFile, JSON.stringify(mock));

  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${firstSessionId}/message`, { text: "long running" });
  await sse.wait(e => e.sessionId === firstSessionId && e.type === "message_start");
  const res = await post(`/api/sessions/${fr.id}/message`, { text: "collide" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "workspace_busy");
  assert.equal(body.bySessionId, firstSessionId);
  const busyEvt = await sse.wait(e => e.sessionId === fr.id && e.type === "workspace_busy");
  assert.equal(busyEvt.bySessionId, firstSessionId);
  await post(`/api/sessions/${firstSessionId}/stop`);
});

test("branch delete: dirty refused, force removes", async () => {
  const st = await (await get("/api/state")).json();
  const p = st.projects.find(x => x.id === projectId);
  const forkBranch = Object.keys(p.worktrees).find(b => b.startsWith("branch/") && fs.existsSync(path.join(p.worktrees[b], "dirty.txt")));
  assert.ok(forkBranch, "expected a dirty fork branch");
  const r1 = await fetch(`${base}/api/projects/${projectId}/branches/${encodeURIComponent(forkBranch)}`, { method: "DELETE" });
  assert.equal(r1.status, 409);
  const r2 = await fetch(`${base}/api/projects/${projectId}/branches/${encodeURIComponent(forkBranch)}?force=1`, { method: "DELETE" });
  assert.equal(r2.status, 200);
});

test("project session creation starts a new session on the project", async () => {
  const r = await post(`/api/projects/${projectId}/sessions`, {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.projectId, projectId);
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.ok(p.sessions.some(s => s.id === body.id));
});

test("settings can persist a custom local repositories root", async () => {
  const customRoot = path.join(tmp, "another-repositories");
  const r = await post("/api/settings", { reposRoot: customRoot });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reposRoot, customRoot);
  assert.equal((await (await get("/api/state")).json()).reposRoot, customRoot);
});

test("checkout workspace cannot be deleted", async () => {
  const r = await fetch(`${base}/api/projects/${projectId}/branches/main`, { method: "DELETE" });
  assert.equal(r.status, 400);
});

let autoProjectId, autoFirstId, autoSecondId, autoRepo, autoFirstMessage, autoSecondMessage, autoBranch;
test("auto projects bind an unbound checkout session on first send", async () => {
  autoRepo = makeRepo("auto-repo");
  const created = await (await post("/api/projects", { repoPath: autoRepo })).json();
  autoProjectId = created.id;
  autoFirstId = created.sessionId;
  const cfg = loadConfig();
  cfg.projects.find(project => project.id === autoProjectId).mode = "auto";
  saveConfig(cfg);

  autoFirstMessage = "Create the auto session parent";
  const sse = new SSE(base + "/api/events");
  const response = await post(`/api/sessions/${autoFirstId}/message`, { text: autoFirstMessage });
  assert.equal(response.status, 200);
  await sse.wait(e => e.sessionId === autoFirstId && e.type === "turn_end");
  const binding = loadBindings()[autoFirstId];
  assert.deepEqual(binding, { branch: "main", workspacePath: autoRepo });
});

test("auto checkout collision suggests a deterministic session branch", async () => {
  const created = await (await post(`/api/projects/${autoProjectId}/sessions`, {})).json();
  autoSecondId = created.id;
  autoSecondMessage = "Second auto session needs a branch";
  const response = await post(`/api/sessions/${autoSecondId}/message`, { text: autoSecondMessage });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "checkout_occupied");
  assert.equal(body.suggestedBranch, sessionSlug(autoSecondMessage));
  assert.equal(body.bySessionId, autoFirstId);
});

test("auto collision branch can be created before sending", async () => {
  autoBranch = sessionSlug(autoSecondMessage);
  const branchResponse = await post(`/api/sessions/${autoSecondId}/branch`, { branch: autoBranch, create: true });
  assert.equal(branchResponse.status, 200);
  const branch = await branchResponse.json();
  const binding = loadBindings()[autoSecondId];
  assert.equal(binding.branch, autoBranch);
  assert.equal(binding.workspacePath, branch.workspacePath);
  assert.notEqual(binding.workspacePath, autoRepo);

  const sse = new SSE(base + "/api/events");
  const response = await post(`/api/sessions/${autoSecondId}/message`, { text: "send on the suggested branch" });
  assert.equal(response.status, 200);
  await sse.wait(e => e.sessionId === autoSecondId && e.type === "turn_end");
});

test("manual projects never create a lazy binding", async () => {
  const manualRepo = makeRepo("manual-repo");
  const created = await (await post("/api/projects", { repoPath: manualRepo })).json();
  const sse = new SSE(base + "/api/events");
  const response = await post(`/api/sessions/${created.sessionId}/message`, { text: "manual project turn" });
  assert.equal(response.status, 200);
  await sse.wait(e => e.sessionId === created.sessionId && e.type === "turn_end");
  assert.equal(loadBindings()[created.sessionId], undefined);
});

test("state reconciliation removes bindings for deleted worktrees", async () => {
  const binding = loadBindings()[autoSecondId];
  ws.removeWorkspace({ repoPath: autoRepo, workspacePath: binding.workspacePath, force: true });
  await get("/api/state");
  assert.equal(loadBindings()[autoSecondId], undefined);
});

test("auto forks use the deterministic session slug with a numeric suffix", async () => {
  const transcript = await (await get(`/api/sessions/${autoFirstId}/transcript`)).json();
  const firstUser = transcript.records.find(record => record.role === "user");
  const response = await post(`/api/sessions/${autoFirstId}/fork`, { atRecordId: firstUser.id });
  assert.equal(response.status, 200);
  const fork = await response.json();
  assert.equal(fork.branch, `${sessionSlug(autoFirstMessage)}.1`);
  assert.ok(fs.existsSync(fork.workspacePath));
});
