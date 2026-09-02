import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;

beforeEach(async () => {
  fixture = await createIsolatedServerFixture({ createProject: false });
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("project hooks run manually and redact operator tokens", async () => {
  const hookRepo = fixture.makeRepo("hook-repo");
  const hookFile = path.join(hookRepo, "hook-ran.txt");
  const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-secret-token";
  try {
    const res = await fixture.createProject({
      repoPath: hookRepo,
      hooks: {
        setup: "printf setup > hook-ran.txt",
        check: "printf check >> hook-ran.txt; printf '%s' \"$OP_SERVICE_ACCOUNT_TOKEN\"",
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
    assert.equal(body.stdout, "[redacted]");
    assert.equal(fs.readFileSync(hookFile, "utf8"), "setupcheck");
    assert.equal((await fixture.post(`/api/sessions/${res.sessionId}/hooks/missing`, {})).status, 404);
  } finally {
    if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
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
