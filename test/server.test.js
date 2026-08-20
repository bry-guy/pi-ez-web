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
});

test("state exposes the API contract and health marker", async () => {
  const state = await (await get("/api/state")).json();
  assert.equal(state.apiContractVersion, 2);
  assert.ok(state.capabilities.includes("provider-auth"));
  assert.ok(state.capabilities.includes("slash-commands"));
  assert.ok(state.capabilities.includes("project-hooks"));
  assert.ok(state.capabilities.includes("pi-resources"));
  assert.ok(state.capabilities.includes("extension-activity"));
  assert.equal(state.piConfiguration.profile.status, "none");
  assert.equal(state.settings.githubClientId, undefined);
  const health = await (await get("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.apiContractVersion, 2);
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
  assert.equal(p.occupied.main.sessionId, firstSessionId);
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

test("file explorer returns current content and HEAD/main diffs safely", async () => {
  const state = await (await get("/api/state")).json();
  const project = state.projects.find(x => x.id === projectId);
  const workspace = project.sessions.find(session => session.id === firstSessionId).workspacePath;
  const baseCommit = git(workspace, "rev-parse", "HEAD").trim();
  const featureFile = path.join(workspace, "feature.js");
  const untrackedFile = path.join(workspace, "scratch.txt");
  const binaryFile = path.join(workspace, "image.bin");
  fs.writeFileSync(featureFile, "const value = 1;\n");
  fs.writeFileSync(untrackedFile, "scratch\n");
  fs.writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3]));
  try {
    const tree = await (await get(`/api/projects/${projectId}/files?branch=feat%2Fjson`)).json();
    assert.ok(tree.tree.some(node => node.p === "feature.js"));

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
    git(workspace, "reset", "--hard", baseCommit);
  }
});

test("remote branch selection creates from the fetched ref", async () => {
  git(repo, "update-ref", "refs/remotes/origin/feature/remote-ui", "HEAD");
  const state = await (await get("/api/state")).json();
  const p = state.projects.find(x => x.id === projectId);
  assert.ok(p.remoteBranches.includes("origin/feature/remote-ui"));

  const selected = await post(`/api/sessions/${firstSessionId}/branch`, {
    branch: "remote-ui", create: true, fromRef: "origin/feature/remote-ui",
  });
  assert.equal(selected.status, 200);
  const selectedBody = await selected.json();
  assert.equal(ws.currentBranch(selectedBody.workspacePath), "remote-ui");
  assert.equal(git(selectedBody.workspacePath, "rev-parse", "HEAD").trim(), git(repo, "rev-parse", "HEAD").trim());

  const duplicate = await post(`/api/sessions/${firstSessionId}/branch`, {
    branch: "remote-ui", create: true, fromRef: "origin/feature/remote-ui",
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, "branch_exists");

  const restored = await post(`/api/sessions/${firstSessionId}/branch`, { branch: "feat/json" });
  assert.equal(restored.status, 200);
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
  await sse.ready;
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

  git(autoRepo, "branch", body.suggestedBranch);
  const third = await (await post(`/api/projects/${autoProjectId}/sessions`, {})).json();
  const collide = await post(`/api/sessions/${third.id}/message`, { text: autoSecondMessage });
  assert.equal(collide.status, 409);
  assert.equal((await collide.json()).suggestedBranch, `${sessionSlug(autoSecondMessage)}-2`);
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
  const otherProjectWorktreePath = repo;
  const bindings = loadBindings();
  bindings["cross-project-session"] = { branch: "main", workspacePath: otherProjectWorktreePath };
  saveBindings(bindings);
  await get("/api/state");
  const reconciled = loadBindings();
  assert.equal(reconciled[autoSecondId], undefined);
  assert.ok(reconciled["cross-project-session"]);
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
