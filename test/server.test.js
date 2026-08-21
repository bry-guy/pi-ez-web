// Integration: boots the app in mock mode on an ephemeral port and drives it
// over HTTP + a raw SSE reader. Asserts the wire contract end-to-end.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as ws from "../server/workspaces.js";
import { chatsDir, loadBindings, loadConfig, saveBindings, saveConfig, sessionSlug } from "../server/config.js";

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
    let ready;
    this.ready = new Promise(resolve => { ready = resolve; });
    this.done = fetch(url).then(async res => {
      ready();
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

test("unknown API failures return structured JSON with a request id", async () => {
  const response = await fetch(base + "/api/projects", {
    method: "POST",
    headers: J,
    body: "{",
  });
  assert.equal(response.status, 500);
  assert.match(response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
  const body = await response.json();
  assert.equal(body.error, "internal_error");
  assert.equal(body.requestId, response.headers.get("x-request-id"));
});

test("serves the UI", async () => {
  const html = await (await get("/")).text();
  assert.match(html, /<pi-app>/);
  assert.match(html, /\/vendor\/marked\.umd\.js/);
  assert.match(html, /\/vendor\/dompurify\.min\.js/);
  const markedAsset = await (await get("/vendor/marked.umd.js")).text();
  const purifierAsset = await (await get("/vendor/dompurify.min.js")).text();
  assert.match(markedAsset, /marked/);
  assert.match(purifierAsset, /DOMPurify/);
  assert.equal((await get("/node_modules/marked/package.json")).status, 404, "node_modules is not generally web-accessible");
  const css = await (await get("/app.css")).text();
  assert.match(css, /--pi-orange/);
  // Custom elements default to display:inline; without this rule the sidebar,
  // header, composer, and file panel are not flex items and collapse.
  assert.match(css, /pi-sidebar[\s\S]{0,200}display:\s*contents/);
  assert.match(css, /aside\.files\s*\{\s*position: absolute; inset: var\(--header-height, 54px\) 0 0 auto;/);
});

test("state exposes the API contract and health marker", async () => {
  const state = await (await get("/api/state")).json();
  assert.equal(state.apiContractVersion, 3);
  assert.ok(state.capabilities.includes("provider-auth"));
  assert.ok(state.capabilities.includes("workspace-actions"));
  assert.ok(state.capabilities.includes("slash-commands"));
  assert.ok(state.capabilities.includes("project-hooks"));
  assert.ok(state.capabilities.includes("pi-resources"));
  assert.ok(state.capabilities.includes("extension-activity"));
  assert.equal(state.piConfiguration.profile.status, "none");
  assert.equal(state.settings.githubClientId, undefined);
  const health = await (await get("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.apiContractVersion, 3);
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
  const forkResponse = await post(`/api/sessions/${b.id}/fork`, {});
  assert.equal(forkResponse.status, 404);
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

test("activity records stream and persist across transcript snapshots", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "track todo and a background agent" });
  const todo = await sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.kind === "todo");
  const agent = await sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.kind === "agent");
  assert.equal(todo.record.key, "todo");
  assert.equal(agent.record.key, "agent:mock");
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.deepEqual(snap.records.filter(r => r.role === "activity").map(r => r.kind), ["todo", "agent"]);
});

test("Pi built-in commands are discoverable and web-adapted", async () => {
  const { id } = await (await post("/api/chats")).json();
  const commands = await (await get(`/api/sessions/${id}/commands`)).json();
  for (const name of ["model", "export", "copy", "compact", "reload", "new", "resume", "quit"]) {
    assert.ok(commands.commands.some(command => command.name === name), `missing /${name}`);
  }
  const session = await (await post(`/api/sessions/${id}/command`, { text: "/session" })).json();
  assert.equal(session.action, "notice");
  const compact = await (await post(`/api/sessions/${id}/command`, { text: "/compact keep it short" })).json();
  assert.equal(compact.action, "refresh");
  const exported = await (await post(`/api/sessions/${id}/command`, { text: "/export jsonl" })).json();
  assert.deepEqual(exported, { ok: true, action: "download", format: "jsonl" });
  const file = await get(`/api/sessions/${id}/export?format=jsonl`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type") || "", /application\/jsonl/);
  assert.match(await file.text(), /\"type\":\"session\"/);
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
test("named project hooks apply before per-project overrides", async () => {
  const hookRepo = makeRepo("named-hook-repo");
  saveConfig({ projectHookSets: { named: { check: "printf named", setup: "printf setup" } } });
  const res = await (await post("/api/projects", { name: "named", repoPath: hookRepo, hooks: { check: "printf override" } })).json();
  assert.equal(res.setup.stdout, "setup");
  const check = await post(`/api/sessions/${res.sessionId}/hooks/check`, {});
  assert.equal((await check.json()).stdout, "override");
});

test("project hook output redacts the operator token", async () => {
  const hookRepo = makeRepo("secret-hook-repo");
  const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-secret-token";
  try {
    const res = await (await post("/api/projects", {
      repoPath: hookRepo,
      hooks: { check: "printf '%s' \"$OP_SERVICE_ACCOUNT_TOKEN\"" },
    })).json();
    const check = await post(`/api/sessions/${res.sessionId}/hooks/check`, {});
    const body = await check.json();
    assert.equal(body.ok, true);
    assert.equal(body.stdout, "[redacted]");
  } finally {
    if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
  }
});

test("project hooks run in the checkout and can be invoked manually", async () => {
  const hookRepo = makeRepo("hook-repo");
  const hookFile = path.join(hookRepo, "hook-ran.txt");
  const res = await (await post("/api/projects", {
    repoPath: hookRepo,
    hooks: {
      setup: "printf setup > hook-ran.txt",
      check: "printf check >> hook-ran.txt",
    },
  })).json();
  assert.equal(res.setup.ok, true);
  assert.equal(fs.readFileSync(hookFile, "utf8"), "setup");
  const state = await (await get("/api/state")).json();
  const hooked = state.projects.find(x => x.id === res.id);
  assert.deepEqual(hooked.hooks, { setup: true, check: true });
  const check = await post(`/api/sessions/${res.sessionId}/hooks/check`, {});
  assert.equal(check.status, 200);
  assert.equal((await check.json()).ok, true);
  assert.equal(fs.readFileSync(hookFile, "utf8"), "setupcheck");
  const missing = await post(`/api/sessions/${res.sessionId}/hooks/missing`, {});
  assert.equal(missing.status, 404);
});

test("project creation: first session on the checkout branch", async () => {
  const res = await (await post("/api/projects", { repoPath: repo })).json();
  projectId = res.id;
  firstSessionId = res.sessionId;
  assert.ok(projectId && firstSessionId);
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.equal(p.branch, "main");
  assert.deepEqual(p.workspaceStatus.main.sessions.map(session => session.id), [firstSessionId]);
  assert.equal(p.occupied, undefined);
  assert.equal(p.mode, undefined);
  assert.equal(p.sessions[0].id, firstSessionId);
  assert.equal(p.sessions[0].branch, "main");
  assert.equal(p.sessions[0].model, "mock/fast");
  assert.deepEqual(p.remoteBranches, []);
});

test("slash command discovery supports /settings and /name", async () => {
  const commands = await (await get(`/api/sessions/${firstSessionId}/commands`)).json();
  const commandNames = commands.commands.map(command => command.name);
  assert.ok(commandNames.includes("settings"));
  assert.ok(commandNames.includes("name"));
  assert.ok(commandNames.includes("compact"));
  const settings = await post(`/api/sessions/${firstSessionId}/command`, { text: "/settings" });
  assert.deepEqual(await settings.json(), { ok: true, action: "settings" });
  const named = await post(`/api/sessions/${firstSessionId}/command`, { text: "/name Web session" });
  assert.equal(named.status, 200);
  assert.equal((await named.json()).name, "Web session");
  assert.equal((await (await get(`/api/sessions/${firstSessionId}/meta`)).json()).name, "Web session");
  const currentName = await post(`/api/sessions/${firstSessionId}/command`, { text: "/name" });
  assert.equal(currentName.status, 200);
  assert.equal((await currentName.json()).action, "notice");
  const unknown = await post(`/api/sessions/${firstSessionId}/command`, { text: "/not-a-command" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "unknown_slash_command");
});

test("dirty checkout fork is refused without stashing the checkout", async () => {
  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${firstSessionId}/message`, { text: "prepare a fork" });
  await sse.wait(e => e.sessionId === firstSessionId && e.type === "turn_end");
  const marker = path.join(repo, "local-only.txt");
  fs.writeFileSync(marker, "keep me\n");
  const r = await post(`/api/sessions/${firstSessionId}/worktree`, { fork: true });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "checkout_dirty");
  assert.equal(fs.readFileSync(marker, "utf8"), "keep me\n");
  fs.rmSync(marker);
});

test("explicit worktree action re-homes the session and exposes shared workspace state", async () => {
  const r = await post(`/api/sessions/${firstSessionId}/worktree`, { branch: "feat/json" });
  assert.equal(r.status, 200);
  const { workspacePath } = await r.json();
  assert.ok(fs.existsSync(path.join(workspacePath, "README.md")));
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.equal(p.sessions[0].branch, "feat/json");
  assert.deepEqual(p.workspaceStatus["feat/json"].sessions.map(session => session.id), [firstSessionId]);
  assert.deepEqual(p.workspaceStatus.main.sessions, []);
});

test("file explorer returns current content and HEAD/main diffs safely", async () => {
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(x => x.id === projectId);
  const workspace = project.sessions.find(session => session.id === firstSessionId).workspacePath;
  const baseCommit = git(workspace, "rev-parse", "HEAD").trim();
  const featureFile = path.join(workspace, "feature.js");
  const untrackedFile = path.join(workspace, "scratch.txt");
  const binaryFile = path.join(workspace, "image.bin");
  const changesDir = path.join(workspace, "changes");
  const removedFile = path.join(changesDir, "removed.txt");
  const modifiedFile = path.join(changesDir, "modified.txt");
  fs.writeFileSync(featureFile, "const value = 1;\n");
  fs.writeFileSync(untrackedFile, "scratch\n");
  fs.writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3]));
  fs.mkdirSync(changesDir, { recursive: true });
  fs.writeFileSync(removedFile, "removed\n");
  fs.writeFileSync(modifiedFile, "before\n");
  git(workspace, "add", "changes");
  git(workspace, "commit", "-m", "temporary diff tree base");
  fs.rmSync(removedFile);
  fs.writeFileSync(modifiedFile, "after\n");
  try {
    const tree = await (await get(`/api/projects/${projectId}/files?branch=feat%2Fjson`)).json();
    assert.equal(tree.target, "none");
    assert.ok(tree.targets.includes("HEAD"));
    assert.ok(tree.tree.some(node => node.p === "feature.js"));
    assert.equal(tree.tree.find(node => node.p === "feature.js").s, undefined);
    const noDiff = await (await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=feature.js&target=none`)).json();
    assert.equal(noDiff.diff, null);

    const diffTree = await (await get(`/api/projects/${projectId}/files?branch=feat%2Fjson&target=HEAD`)).json();
    const diffNodes = nodes => nodes.flatMap(node => [node, ...(node.c ? diffNodes(node.c) : [])]);
    const changed = new Map(diffNodes(diffTree.tree).map(node => [node.p, node]));
    assert.equal(diffTree.target, "HEAD");
    assert.equal(changed.get("feature.js").s, "new");
    assert.equal(changed.get("changes/removed.txt").s, "removed");
    assert.equal(changed.get("changes/modified.txt").s, "modified");
    assert.equal(changed.get("changes").s, "modified");
    assert.equal(changed.get("README.md").s, undefined);

    const current = await (await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=feature.js&target=HEAD`)).json();
    assert.equal(current.content, "const value = 1;\n");
    assert.equal(current.target, "HEAD");
    assert.equal(current.diff.changed, true);
    assert.equal(current.diff.adds, 1);
    assert.match(current.highlighted, /hljs/);

    const traversal = await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=..%2Fpackage.json&target=HEAD`);
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).error, "invalid_file_path");
    const gitConfig = await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=.git%2Fconfig&target=HEAD`);
    assert.equal(gitConfig.status, 400);
    assert.equal((await gitConfig.json()).error, "invalid_file_path");

    const binary = await (await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=image.bin&target=HEAD`)).json();
    assert.equal(binary.binary, true);
    assert.equal(binary.diff.binary, true);
    assert.equal(binary.diff.changed, true);

    git(workspace, "add", "feature.js");
    git(workspace, "commit", "-m", "temporary feature file");
    const cleanHead = await (await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=feature.js&target=HEAD`)).json();
    assert.equal(cleanHead.diff.changed, false);
    const mainDiff = await (await get(`/api/projects/${projectId}/file?branch=feat%2Fjson&path=feature.js&target=main`)).json();
    assert.equal(mainDiff.target, "main");
    assert.equal(mainDiff.diff.changed, true);
    assert.equal(mainDiff.diff.adds, 1);
  } finally {
    fs.rmSync(untrackedFile, { force: true });
    fs.rmSync(binaryFile, { force: true });
    fs.rmSync(changesDir, { recursive: true, force: true });
    git(workspace, "reset", "--hard", baseCommit);
  }
});

test("remote branch selection creates from the fetched ref", async () => {
  git(repo, "update-ref", "refs/remotes/origin/feature/remote-ui", "HEAD");
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.ok(p.remoteBranches.includes("origin/feature/remote-ui"));

  const selected = await post(`/api/sessions/${firstSessionId}/worktree`, {
    branch: "remote-ui", fromRef: "origin/feature/remote-ui",
  });
  assert.equal(selected.status, 200, await selected.clone().text());
  const selectedBody = await selected.json();
  assert.equal(ws.currentBranch(selectedBody.workspacePath), "remote-ui");
  assert.equal(git(selectedBody.workspacePath, "rev-parse", "HEAD").trim(), git(repo, "rev-parse", "HEAD").trim());

  const duplicate = await post(`/api/sessions/${firstSessionId}/worktree`, {
    branch: "remote-ui", fromRef: "origin/feature/remote-ui",
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).branch, "remote-ui");

  const restored = await post(`/api/sessions/${firstSessionId}/worktree`, { branch: "feat/json" });
  assert.equal(restored.status, 200);
});

test("shared sessions can run turns and workspace commands without occupancy locks", async () => {
  const sse = new SSE(base + "/api/events");
  const a = await supervisor.createSession({ cwd: repo });
  const a2 = await supervisor.createSession({ cwd: repo });
  await post(`/api/sessions/${a.id}/message`, { text: "shared session one" });
  await post(`/api/sessions/${a2.id}/message`, { text: "shared session two" });
  await sse.wait(e => e.sessionId === a.id && e.type === "turn_end");
  await sse.wait(e => e.sessionId === a2.id && e.type === "turn_end");
  const bang = await post(`/api/sessions/${a2.id}/bang`, { cmd: "pwd" });
  assert.equal(bang.status, 200);
  await sse.wait(e => e.sessionId === a2.id && e.type === "bang_end");
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(p => p.id === projectId);
  const shared = project.workspaceStatus.main.sessions.map(session => session.id);
  assert.ok(shared.includes(a.id));
  assert.ok(shared.includes(a2.id));
});

test("worktree action allows another session to share the same workspace", async () => {
  const shared = await (await post(`/api/projects/${projectId}/sessions`, {})).json();
  const moved = await post(`/api/sessions/${shared.id}/worktree`, { branch: "feat/json" });
  assert.equal(moved.status, 200);
  const p = (await (await get("/api/state")).json()).projects.find(project => project.id === projectId);
  assert.deepEqual(new Set(p.workspaceStatus["feat/json"].sessions.map(session => session.id)), new Set([firstSessionId, shared.id]));
});

test("fork option carries dirty workspace state point-in-time", async () => {
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  const parentWs = p.worktrees["feat/json"];
  fs.writeFileSync(path.join(parentWs, "dirty.txt"), "uncommitted\n");

  const sse = new SSE(base + "/api/events");
  await sse.ready;
  const response = await post(`/api/sessions/${firstSessionId}/worktree`, { fork: true, branch: "branch/json-dirty" });
  assert.equal(response.status, 200);
  const fr = await response.json();
  assert.ok(fs.existsSync(path.join(fr.workspacePath, "dirty.txt")));
  assert.ok(fs.existsSync(path.join(parentWs, "dirty.txt")));
  await sse.wait(e => e.type === "session_forked" && e.sessionId === fr.id);
  const st2 = await (await get("/api/state")).json();
  const p2 = st2.projects.find(x => x.id === projectId);
  assert.equal(p2.workspaceStatus[fr.branch].sessions[0].id, fr.id);
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
  const fr = await (await post(`/api/sessions/${firstSessionId}/worktree`, { fork: true, branch: "branch/json-truncated", atRecordId: secondUser.id })).json();
  const forkSnap = await (await get(`/api/sessions/${fr.id}/transcript`)).json();
  const users = forkSnap.records.filter(r => r.role === "user").map(r => r.text);
  assert.deepEqual(users, ["prepare a fork"]); // truncated before "turn one"

  const st = await (await get("/api/state")).json();
  const p = st.projects.find(x => x.id === projectId);
  const parentNode = JSON.stringify(p.sessions);
  assert.match(parentNode, new RegExp(fr.id)); // fork appears in the tree
});

test("standalone branch and fork endpoints are removed", async () => {
  const branch = await post(`/api/sessions/${firstSessionId}/branch`, { branch: "legacy" });
  assert.equal(branch.status, 404);
  const fork = await post(`/api/sessions/${firstSessionId}/fork`, {});
  assert.equal(fork.status, 404);
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

test("settings expose and persist Pi package and extension configuration", async () => {
  let r = await post("/api/settings", {
    pi: { profile: null, packages: ["npm:context-mode"], extensions: ["./extensions/example.ts"] },
  });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual(body.piConfiguration.config.packages, ["npm:context-mode"]);
  assert.deepEqual(loadConfig().pi.extensions, ["./extensions/example.ts"]);

  r = await post("/api/settings", { pi: { packages: "invalid" } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_pi_configuration");

  await post("/api/settings", { pi: { profile: null, packages: [], extensions: [] } });
});

test("settings reject malformed GitHub owner values", async () => {
  const r = await post("/api/settings", { githubOwner: "not valid!" });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "invalid_github_owner");
  assert.match(body.message, /valid GitHub/i);
});

test("model state distinguishes Automatic from an explicit default", async () => {
  let r = await post("/api/settings", { defaultModel: null });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.defaultModel, null);
  assert.equal(body.effectiveDefaultModel, "mock/fast");
  assert.equal(body.defaultModelStatus, "automatic");

  r = await post("/api/settings", { defaultModel: "mock/smart" });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.defaultModel, "mock/smart");
  assert.equal(body.effectiveDefaultModel, "mock/smart");
  assert.equal(body.defaultModelStatus, "available");

  r = await post("/api/settings", { defaultThinkingLevel: "xhigh" });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.defaultThinkingLevel, "xhigh");
  r = await post("/api/settings", { defaultThinkingLevel: "bogus" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_thinking_level");

  r = await post("/api/settings", { defaultModel: "not-a-model" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "model_unavailable");
  await post("/api/settings", { defaultModel: null });
});

test("checkout workspace cannot be deleted", async () => {
  const r = await fetch(`${base}/api/projects/${projectId}/branches/main`, { method: "DELETE" });
  assert.equal(r.status, 400);
});

test("sessions stay on their current workspace unless Worktree is requested", async () => {
  const manualRepo = makeRepo("manual-repo");
  const created = await (await post("/api/projects", { repoPath: manualRepo })).json();
  const second = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${created.sessionId}/message`, { text: "manual project turn" });
  await sse.wait(e => e.sessionId === created.sessionId && e.type === "turn_end");
  assert.equal(loadBindings()[created.sessionId], undefined);
  assert.equal(loadBindings()[second.id], undefined);
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(item => item.id === created.id);
  assert.equal(project.workspaceStatus.main.sessions.length, 2);
});

test("switch changes the session workspace branch without creating a worktree", async () => {
  const switchRepo = makeRepo("switch-repo");
  git(switchRepo, "branch", "feature/switch");
  const created = await (await post("/api/projects", { repoPath: switchRepo })).json();
  assert.deepEqual(ws.listWorktrees(switchRepo), { main: switchRepo });

  const switched = await post(`/api/sessions/${created.sessionId}/switch`, { branch: "feature/switch" });
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.equal((await switched.json()).workspacePath, switchRepo);
  assert.equal(ws.currentBranch(switchRepo), "feature/switch");
  assert.deepEqual(ws.listWorktrees(switchRepo), { "feature/switch": switchRepo });

  let state = await (await get("/api/state")).json();
  let project = state.projects.find(item => item.id === created.id);
  const node = project.sessions.find(session => session.id === created.sessionId);
  assert.equal(node.branch, "feature/switch");

  const restored = await post(`/api/sessions/${created.sessionId}/switch`, { branch: "main" });
  assert.equal(restored.status, 200);
  assert.equal(ws.currentBranch(switchRepo), "main");
  assert.deepEqual(ws.listWorktrees(switchRepo), { main: switchRepo });
});

test("main stays at the checkout when a session returns from a worktree", async () => {
  const returnRepo = makeRepo("return-main-repo");
  git(returnRepo, "branch", "checkout-away");
  const created = await (await post("/api/projects", { repoPath: returnRepo })).json();
  const checkoutSession = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  const branchSession = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  await post(`/api/sessions/${branchSession.id}/worktree`, { branch: "feat/return" });
  const worktree = (await (await get("/api/state")).json()).projects.find(item => item.id === created.id).worktrees["feat/return"];

  const movedCheckout = await post(`/api/sessions/${checkoutSession.id}/switch`, { branch: "checkout-away" });
  assert.equal(movedCheckout.status, 200);
  assert.equal(ws.currentBranch(returnRepo), "checkout-away");

  const returned = await post(`/api/sessions/${branchSession.id}/switch`, { branch: "main" });
  assert.equal(returned.status, 200, await returned.clone().text());
  assert.equal(ws.currentBranch(returnRepo), "main");
  assert.equal(ws.listWorktrees(returnRepo).main, returnRepo);
  assert.equal(ws.listWorktrees(returnRepo)["feat/return"], worktree);
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(item => item.id === created.id);
  const checkoutNode = project.sessions.find(session => session.id === checkoutSession.id);
  const returnedNode = project.sessions.find(session => session.id === branchSession.id);
  assert.equal(checkoutNode.branch, "main");
  assert.equal(returnedNode.branch, "main");
  assert.equal(project.workspaceStatus["feat/return"].sessions.length, 0);

  const forbidden = await post(`/api/sessions/${branchSession.id}/worktree`, { branch: "main" });
  assert.equal(forbidden.status, 409);
  assert.equal((await forbidden.json()).error, "main_worktree_forbidden");
});

test("merge always targets main even when the checkout is on another branch", async () => {
  const mergeRepo = makeRepo("merge-main-repo");
  git(mergeRepo, "branch", "checkout-away");
  const created = await (await post("/api/projects", { repoPath: mergeRepo })).json();
  const checkoutSession = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  const sourceSession = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  await post(`/api/sessions/${sourceSession.id}/worktree`, { branch: "feat/merge-main" });
  const sourcePath = (await (await get("/api/state")).json()).projects.find(item => item.id === created.id).worktrees["feat/merge-main"];
  fs.writeFileSync(path.join(sourcePath, "merged.txt"), "merged\n");
  git(sourcePath, "add", "-A"); git(sourcePath, "commit", "-m", "merge main");
  const movedCheckout = await post(`/api/sessions/${checkoutSession.id}/switch`, { branch: "checkout-away" });
  assert.equal(movedCheckout.status, 200);

  const merged = await post(`/api/sessions/${sourceSession.id}/merge`);
  assert.equal(merged.status, 200, await merged.clone().text());
  assert.equal((await merged.json()).into, "main");
  assert.equal(ws.currentBranch(mergeRepo), "main");
  assert.equal(fs.readFileSync(path.join(mergeRepo, "merged.txt"), "utf8"), "merged\n");
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(item => item.id === created.id);
  assert.equal(project.sessions.find(session => session.id === checkoutSession.id).branch, "main");
  assert.equal(project.sessions.find(session => session.id === sourceSession.id).branch, "main");
  assert.equal(project.branches.includes("feat/merge-main"), false);
});

test("external main worktrees block return without being removed", async () => {
  const externalRepo = makeRepo("external-main-repo");
  git(externalRepo, "branch", "checkout-away");
  const created = await (await post("/api/projects", { repoPath: externalRepo })).json();
  const externalPath = path.join(tmp, "external-main-worktree");
  git(externalRepo, "switch", "checkout-away");
  git(externalRepo, "worktree", "add", externalPath, "main");
  const blocked = await post(`/api/sessions/${created.sessionId}/switch`, { branch: "main" });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "main_worktree_external");
  assert.equal(fs.existsSync(externalPath), true);
  const closed = await post(`/api/sessions/${created.sessionId}/close`);
  assert.equal(closed.status, 200);
  assert.equal(fs.existsSync(externalPath), true);
  git(externalRepo, "worktree", "remove", externalPath);
  git(externalRepo, "switch", "main");
});

test("blank Worktree names use the session slug and avoid collisions", async () => {
  const namedRepo = makeRepo("named-worktree-repo");
  const created = await (await post("/api/projects", { repoPath: namedRepo })).json();
  const message = "Create the manual session workspace";
  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${created.sessionId}/message`, { text: message });
  await sse.wait(e => e.sessionId === created.sessionId && e.type === "turn_end");
  const first = await (await post(`/api/sessions/${created.sessionId}/worktree`, {})).json();
  assert.equal(first.branch, sessionSlug(message));
  const second = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  const secondSse = new SSE(base + "/api/events");
  await post(`/api/sessions/${second.id}/message`, { text: message });
  await secondSse.wait(e => e.sessionId === second.id && e.type === "turn_end");
  await post(`/api/sessions/${second.id}/worktree`, {});
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(item => item.id === created.id);
  assert.ok(project.branches.includes(`${sessionSlug(message)}-2`));
});

test("Pull fast-forwards the current workspace and returns Git output", async () => {
  const pullRepo = makeRepo("pull-repo");
  const remote = path.join(tmp, "pull-remote.git");
  execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" });
  git(pullRepo, "remote", "add", "origin", remote);
  git(pullRepo, "push", "-u", "origin", "main");
  const clone = path.join(tmp, "pull-clone");
  execFileSync("git", ["clone", "--branch", "main", remote, clone], { encoding: "utf8" });
  git(clone, "config", "user.email", "t@t"); git(clone, "config", "user.name", "t");
  fs.writeFileSync(path.join(clone, "pulled.txt"), "pulled\n");
  git(clone, "add", "-A"); git(clone, "commit", "-m", "remote change"); git(clone, "push");
  const created = await (await post("/api/projects", { repoPath: pullRepo })).json();
  const response = await post(`/api/sessions/${created.sessionId}/pull`);
  assert.equal(response.status, 200);
  assert.match((await response.json()).stdout, /Fast-forward|Updating|Already up to date/);
  assert.equal(fs.readFileSync(path.join(pullRepo, "pulled.txt"), "utf8"), "pulled\n");
});

test("merge stops and rehomes every session sharing a dirty worktree", async () => {
  const mergeRepo = makeRepo("shared-merge-repo");
  const created = await (await post("/api/projects", { repoPath: mergeRepo })).json();
  const second = await (await post(`/api/projects/${created.id}/sessions`, {})).json();
  await post(`/api/sessions/${created.sessionId}/worktree`, { branch: "feat/shared-merge" });
  await post(`/api/sessions/${second.id}/worktree`, { branch: "feat/shared-merge" });
  const state = await (await get("/api/state")).json();
  const workspace = state.projects.find(item => item.id === created.id).workspaceStatus["feat/shared-merge"].path;
  fs.writeFileSync(path.join(workspace, "merged.txt"), "merged\n");
  git(workspace, "add", "-A"); git(workspace, "commit", "-m", "shared merge");
  fs.writeFileSync(path.join(workspace, "uncommitted.txt"), "discard me\n");
  const sse = new SSE(base + "/api/events");
  await post(`/api/sessions/${created.sessionId}/message`, { text: "active before merge" });
  await sse.wait(e => e.sessionId === created.sessionId && e.type === "message_start");
  const merged = await post(`/api/sessions/${created.sessionId}/merge`);
  assert.equal(merged.status, 200);
  const body = await merged.json();
  assert.deepEqual(new Set(body.sessionIds), new Set([created.sessionId, second.id]));
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.readFileSync(path.join(mergeRepo, "merged.txt"), "utf8"), "merged\n");
  const after = await (await get("/api/state")).json();
  const project = after.projects.find(item => item.id === created.id);
  assert.deepEqual(new Set(project.workspaceStatus.main.sessions.map(session => session.id)), new Set([created.sessionId, second.id]));
});
