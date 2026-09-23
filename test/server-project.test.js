import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadConfig, saveConfig } from "../server/config.js";
import { hub } from "../server/events.js";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;

beforeEach(async () => {
  fixture = await createIsolatedServerFixture({ createProject: false });
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("project hooks run manually with an allowlisted environment", async () => {
  const hookRepo = fixture.makeRepo("hook-repo");
  const hookFile = path.join(hookRepo, "hook-ran.txt");
  const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const previousPrivate = process.env.HOOK_PRIVATE;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-secret-token";
  process.env.HOOK_PRIVATE = "not-inherited";
  try {
    const res = await fixture.createProject({
      repoPath: hookRepo,
      hooks: {
        setup: "printf setup > hook-ran.txt",
        check: "printf check >> hook-ran.txt; printf '%s/%s' \"${OP_SERVICE_ACCOUNT_TOKEN:-missing}\" \"${HOOK_PRIVATE:-missing}\"",
      },
    });
    assert.equal(res.setup, null);
    assert.equal(res.setupNeeded, true);
    assert.equal(fs.existsSync(hookFile), false);

    const setup = await fixture.post(`/api/sessions/${res.sessionId}/hooks/setup`, {});
    assert.equal((await setup.json()).ok, true);
    assert.equal(fs.readFileSync(hookFile, "utf8"), "setup");
    const check = await fixture.post(`/api/sessions/${res.sessionId}/hooks/check`, {});
    assert.equal(check.status, 200);
    const body = await check.json();
    assert.equal(body.ok, true);
    assert.equal(body.stdout, "missing/missing");
    assert.equal(fs.readFileSync(hookFile, "utf8"), "setupcheck");
    assert.equal((await fixture.post(`/api/sessions/${res.sessionId}/hooks/missing`, {})).status, 404);
  } finally {
    if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
    if (previousPrivate === undefined) delete process.env.HOOK_PRIVATE;
    else process.env.HOOK_PRIVATE = previousPrivate;
  }
});

test("configured setup hooks receive project environment mappings", async () => {
  const hookRepo = fixture.makeRepo("automatic-environment-repo");
  const marker = path.join(hookRepo, "setup-environment.txt");
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "piweb-hook-home-"));
  const previous = Object.fromEntries(["PROJECT_SETUP_SOURCE", "PROJECT_SETUP_VALUE", "HOME"].map(name => [name, process.env[name]]));
  process.env.PROJECT_SETUP_SOURCE = "setup-value";
  delete process.env.PROJECT_SETUP_VALUE;
  process.env.HOME = home;
  try {
    const created = await fixture.createProject({
      repoPath: hookRepo,
      hooks: { setup: "printf '%s' \"$PROJECT_SETUP_VALUE\" > setup-environment.txt" },
    });
    const cfg = loadConfig();
    cfg.projects.find(project => project.id === created.id).environment = {
      PROJECT_SETUP_VALUE: "PROJECT_SETUP_SOURCE",
    };
    saveConfig(cfg);
    const response = await fixture.post(`/api/sessions/${created.sessionId}/hooks/setup`, {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(fs.readFileSync(marker, "utf8"), "setup-value");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("manual project mappings resolve on every hook execution without widening the allowlist", async () => {
  const hookRepo = fixture.makeRepo("manual-environment-repo");
  const previous = Object.fromEntries(["PROJECT_HOOK_A", "PROJECT_HOOK_B", "PROJECT_HOOK_MODE", "PROJECT_HOOK_VALUE", "PI_WEB_MODE", "HOOK_PRIVATE"].map(name => [name, process.env[name]]));
  process.env.PROJECT_HOOK_A = "hook-alpha";
  process.env.PROJECT_HOOK_B = "hook-beta";
  process.env.PROJECT_HOOK_MODE = "mapped-mode";
  process.env.HOOK_PRIVATE = "inherited-private";
  delete process.env.PROJECT_HOOK_VALUE;
  delete process.env.PI_WEB_MODE;
  try {
    const created = await fixture.createProject({
      repoPath: hookRepo,
      hooks: { check: "printf '%s/%s/%s' \"$PROJECT_HOOK_VALUE\" \"$PI_WEB_MODE\" \"${HOOK_PRIVATE:-missing}\"" },
    });
    const cfg = loadConfig();
    const project = cfg.projects.find(item => item.id === created.id);
    project.environment = {
      PROJECT_HOOK_VALUE: "PROJECT_HOOK_A",
      PI_WEB_MODE: "PROJECT_HOOK_MODE",
    };
    saveConfig(cfg);
    const before = { ...process.env };
    let response = await fixture.post(`/api/sessions/${created.sessionId}/hooks/check`, {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).stdout, "hook-alpha/mapped-mode/missing");
    project.environment.PROJECT_HOOK_VALUE = "PROJECT_HOOK_B";
    saveConfig(cfg);
    response = await fixture.post(`/api/sessions/${created.sessionId}/hooks/check`, {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).stdout, "hook-beta/mapped-mode/missing");
    assert.deepEqual({ ...process.env }, before);
    assert.doesNotMatch(JSON.stringify(await fixture.state()), /hook-alpha|hook-beta/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("missing project environment sources stop hooks before spawning", async () => {
  const hookRepo = fixture.makeRepo("missing-environment-repo");
  const marker = path.join(hookRepo, "must-not-run.txt");
  const quoted = `'${marker.replaceAll("'", "'\\''")}'`;
  const previous = Object.fromEntries(["PROJECT_SOURCE_MISSING", "PROJECT_VALUE"].map(name => [name, process.env[name]]));
  delete process.env.PROJECT_SOURCE_MISSING;
  delete process.env.PROJECT_VALUE;
  try {
    const created = await fixture.createProject({
      repoPath: hookRepo,
      hooks: { check: `printf spawned > ${quoted}` },
    });
    const cfg = loadConfig();
    cfg.projects.find(item => item.id === created.id).environment = { PROJECT_VALUE: "PROJECT_SOURCE_MISSING" };
    saveConfig(cfg);
    const response = await fixture.post(`/api/sessions/${created.sessionId}/hooks/check`, {});
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "project_environment_source_missing");
    assert.equal(body.message, "Project environment source is missing.");
    assert.equal(body.operation.status, "error");
    assert.equal(body.operation.events.some(event => event.type === "process_start"), false);
    assert.doesNotMatch(JSON.stringify(body), /PROJECT_SOURCE_MISSING/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("bang environments are isolated, dynamic, Git-authenticated, and absent for unbound chats", async () => {
  const repoA = fixture.makeRepo("bang-environment-a");
  const repoB = fixture.makeRepo("bang-environment-b");
  const previous = Object.fromEntries(["PROJECT_BANG_A", "PROJECT_BANG_B", "PROJECT_BANG_TOKEN", "PROJECT_VALUE", "PI_WEB_GITHUB_TOKEN", "GIT_ASKPASS"].map(name => [name, process.env[name]]));
  process.env.PROJECT_BANG_A = "bang-alpha";
  process.env.PROJECT_BANG_B = "bang-beta";
  process.env.PROJECT_BANG_TOKEN = "synthetic-token";
  delete process.env.PROJECT_VALUE;
  delete process.env.PI_WEB_GITHUB_TOKEN;
  delete process.env.GIT_ASKPASS;
  try {
    const projectA = await fixture.createProject({ repoPath: repoA });
    const projectB = await fixture.createProject({ repoPath: repoB });
    const cfg = loadConfig();
    cfg.projects.find(item => item.id === projectA.id).environment = {
      PROJECT_VALUE: "PROJECT_BANG_A",
      PI_WEB_GITHUB_TOKEN: "PROJECT_BANG_TOKEN",
      GIT_ASKPASS: "PROJECT_BANG_TOKEN",
    };
    cfg.projects.find(item => item.id === projectB.id).environment = { PROJECT_VALUE: "PROJECT_BANG_B" };
    saveConfig(cfg);
    const before = { ...process.env };
    const bang = async (id, command) => {
      const response = await fixture.post(`/api/sessions/${id}/bang`, { cmd: command });
      assert.equal(response.status, 200, await response.clone().text());
      const transcript = await (await fixture.get(`/api/sessions/${id}/transcript`)).json();
      return transcript.records.at(-1).out;
    };
    const gitCommand = "printf '%s/' \"${PROJECT_VALUE:-missing}\"; if [ -z \"${GIT_ASKPASS-}\" ] && printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | grep -q 'password=synthetic-token'; then printf git-ok; else printf git-fail; fi";
    const [outA, outB] = await Promise.all([
      bang(projectA.sessionId, `sleep 0.05; ${gitCommand}`),
      bang(projectB.sessionId, "sleep 0.05; printf '%s' \"${PROJECT_VALUE:-missing}\""),
    ]);
    assert.equal(outA, "bang-alpha/git-ok");
    assert.equal(outB, "bang-beta");
    assert.deepEqual({ ...process.env }, before);

    cfg.projects.find(item => item.id === projectA.id).environment.PROJECT_VALUE = "PROJECT_BANG_B";
    saveConfig(cfg);
    assert.equal(await bang(projectA.sessionId, "printf '%s' \"${PROJECT_VALUE:-missing}\""), "bang-beta");
    cfg.projects.find(item => item.id === projectA.id).environment = {};
    saveConfig(cfg);
    assert.equal(await bang(projectA.sessionId, "printf '%s' \"${PROJECT_VALUE:-missing}\""), "missing");

    const chat = await (await fixture.post("/api/chats", {})).json();
    assert.equal(await bang(chat.id, "printf '%s' \"${PROJECT_VALUE:-missing}\""), "missing");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("missing project environment sources stop bang before spawning or emitting events", async () => {
  const repo = fixture.makeRepo("missing-bang-environment-repo");
  const marker = path.join(repo, "must-not-run.txt");
  const quoted = `'${marker.replaceAll("'", "'\\''")}'`;
  const created = await fixture.createProject({ repoPath: repo });
  const cfg = loadConfig();
  cfg.projects.find(item => item.id === created.id).environment = { PROJECT_VALUE: "BANG_SOURCE_MISSING" };
  saveConfig(cfg);
  const previous = Object.fromEntries(["BANG_SOURCE_MISSING", "PROJECT_VALUE"].map(name => [name, process.env[name]]));
  delete process.env.BANG_SOURCE_MISSING;
  delete process.env.PROJECT_VALUE;
  const frames = [];
  const remove = hub.addClient(frame => frames.push(frame));
  const parseEvents = () => frames.flatMap(frame => frame.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))));
  try {
    hub.emit(created.sessionId, "parser_probe");
    assert.equal(parseEvents().at(-1).type, "parser_probe");
    frames.length = 0;
    const response = await fixture.post(`/api/sessions/${created.sessionId}/bang`, { cmd: `printf spawned > ${quoted}` });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, { error: "project_environment_source_missing", message: "Project environment source is missing." });
    assert.equal(fs.existsSync(marker), false);
    const transcript = await (await fixture.get(`/api/sessions/${created.sessionId}/transcript`)).json();
    assert.equal(transcript.records.some(record => record.role === "bang"), false);
    assert.equal(parseEvents().some(event => event.type === "bang_start" || event.type === "bang_end"), false);
  } finally {
    remove();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("bang mappings follow worktree and fork bindings", async () => {
  const created = await fixture.createProject({ repoPath: fixture.repo });
  const previous = Object.fromEntries(["PROJECT_WORKSPACE_SOURCE", "PROJECT_VALUE"].map(name => [name, process.env[name]]));
  delete process.env.PROJECT_VALUE;
  process.env.PROJECT_WORKSPACE_SOURCE = "workspace-value";
  try {
    const cfg = loadConfig();
    cfg.projects.find(item => item.id === created.id).environment = { PROJECT_VALUE: "PROJECT_WORKSPACE_SOURCE" };
    saveConfig(cfg);
    const worktree = await (await fixture.post(`/api/sessions/${created.sessionId}/worktree`, { branch: "feat/environment" })).json();
    const bang = async id => {
      const response = await fixture.post(`/api/sessions/${id}/bang`, { cmd: "printf '%s' \"$PROJECT_VALUE\"" });
      assert.equal(response.status, 200, await response.clone().text());
      const transcript = await (await fixture.get(`/api/sessions/${id}/transcript`)).json();
      return transcript.records.at(-1).out;
    };
    assert.equal(await bang(created.sessionId), "workspace-value");
    assert.equal(worktree.workspacePath !== fixture.repo, true);
    const fork = await (await fixture.post(`/api/sessions/${created.sessionId}/fork`, {})).json();
    assert.equal(await bang(fork.id), "workspace-value");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("setup hooks do not block messages on the newly bound session", async () => {
  const hookRepo = fixture.makeRepo("concurrent-setup-repo");
  const res = await fixture.createProject({
    repoPath: hookRepo,
    hooks: { setup: "sleep 0.4; printf setup > setup-ran.txt" },
  });
  assert.equal(res.setup, null);
  assert.equal(res.setupNeeded, true);
  const setup = fixture.post(`/api/sessions/${res.sessionId}/hooks/setup`, {});
  const message = await fixture.post(`/api/sessions/${res.sessionId}/message`, { text: "message while setup runs" });
  assert.equal(message.status, 200, await message.clone().text());
  assert.equal((await (await setup).json()).ok, true);
  assert.equal(fs.readFileSync(path.join(hookRepo, "setup-ran.txt"), "utf8"), "setup");
});

test("project creation: first session on the checkout branch", async () => {
  const res = await fixture.createProject({ repoPath: fixture.repo });
  assert.ok(res.id && res.sessionId);
  assert.equal(res.setup, null);
  assert.equal(res.setupNeeded, false);
  const state = await fixture.state();
  const project = state.projects.find(item => item.id === res.id);
  assert.equal(project.branch, "main");
  assert.equal(project.defaultBranch, "main");
  assert.deepEqual(project.workspaceStatus.main.sessions.map(session => session.id), [res.sessionId]);
  assert.equal(project.occupied, undefined);
  assert.equal(project.mode, undefined);
  assert.equal(project.sessions[0].id, res.sessionId);
  assert.equal(project.sessions[0].branch, "main");
  assert.equal(project.sessions[0].model, "mock/fast");
  assert.deepEqual(project.remoteBranches, []);
});

test("explicit worktree action re-homes the session and exposes shared workspace state", async () => {
  const created = await fixture.createProject({ repoPath: fixture.repo });
  const response = await fixture.post(`/api/sessions/${created.sessionId}/worktree`, { branch: "feat/json" });
  assert.equal(response.status, 200);
  const { branch, workspacePath } = await response.json();
  assert.equal(branch, "feat/json");
  assert.ok(fs.existsSync(path.join(workspacePath, "README.md")));
  const meta = await (await fixture.get(`/api/sessions/${created.sessionId}/meta`)).json();
  assert.equal(meta.cwd, workspacePath);
});

test("file explorer rejects traversal and Git metadata paths", async () => {
  const created = await fixture.createProject({ repoPath: fixture.repo });
  const worktree = await (await fixture.post(`/api/sessions/${created.sessionId}/worktree`, { branch: "feat/json" })).json();
  const traversal = await fixture.get(`/api/projects/${created.id}/file?branch=feat%2Fjson&path=..%2Fpackage.json`);
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).error, "invalid_file_path");
  const { readFileView } = await import("../server/file-explorer.js");
  assert.throws(() => readFileView({ workspace: worktree.workspacePath, repoPath: fixture.repo, path: ".git/config" }), error => error?.code === "invalid_file_path");
});

test("fork action creates a child in the session tree", async () => {
  const created = await fixture.createProject({ repoPath: fixture.repo });
  const response = await fixture.post(`/api/sessions/${created.sessionId}/fork`, {});
  assert.equal(response.status, 200, await response.clone().text());
  const fork = await response.json();
  assert.ok(fork.id);
  assert.equal(fork.forkedFrom, created.sessionId);
  assert.equal(fork.workspacePath, fixture.repo);
});
