import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadBindings, saveBindings } from "../server/config.js";
import * as ws from "../server/workspaces.js";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge-local refuses dirty worktree changes without cleanup", async () => {
  const branch = "feat/dirty-merge";
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession(branch);
  const wip = path.join(worktree, "wip.txt");
  const tracked = path.join(worktree, "README.md");
  fs.writeFileSync(wip, "uncommitted\n");
  fs.writeFileSync(tracked, "locally edited\n");
  const mainHead = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  const worktreeHead = fixture.git(worktree, "rev-parse", "HEAD").trim();
  const branchHead = fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim();
  const status = fixture.git(worktree, "status", "--short");
  const worktrees = ws.listWorktrees(fixture.repo);
  const binding = loadBindings()[sessionId];
  const meta = await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json();

  const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "workspace_dirty");
  assert.equal(fs.readFileSync(wip, "utf8"), "uncommitted\n");
  assert.equal(fs.readFileSync(tracked, "utf8"), "locally edited\n");
  assert.equal(fixture.git(fixture.repo, "rev-parse", "HEAD").trim(), mainHead);
  assert.equal(fixture.git(worktree, "rev-parse", "HEAD").trim(), worktreeHead);
  assert.equal(fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim(), branchHead);
  assert.equal(fixture.git(worktree, "status", "--short"), status);
  assert.deepEqual(ws.listWorktrees(fixture.repo), worktrees);
  assert.deepEqual(loadBindings()[sessionId], binding);
  assert.deepEqual(await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json(), meta);
});

test("merge rehomes do not overwrite unrelated concurrent binding changes", async () => {
  const { sessionId } = await fixture.createWorktreeSession("feat/bindings");
  const unrelated = await fixture.createBoundSession();
  const rehome = fixture.supervisor.rehome.bind(fixture.supervisor);
  fixture.supervisor.rehome = async (id, cwd) => {
    const bindings = loadBindings();
    bindings[unrelated] = { projectId: "concurrent-update", workspacePath: fixture.repo };
    saveBindings(bindings);
    await rehome(id, cwd);
  };
  const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(loadBindings()[unrelated].projectId, "concurrent-update");
});

test("deletion does not remove a source whose required rehome fails", async () => {
  const branch = "feat/rehome-failure";
  const { workspacePath } = await fixture.createWorktreeSession(branch);
  fixture.supervisor.rehome = async () => { throw new Error("intentional rehome failure"); };
  const response = await fixture.remove(`/api/projects/${fixture.projectId}/branches/${encodeURIComponent(branch)}`);
  assert.equal(response.status, 500);
  assert.equal(fs.existsSync(workspacePath), true);
  assert.ok(fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim());
});

test("retired merge route returns 404 without changing Git or session state", async () => {
  const branch = "feat/legacy-merge";
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession(branch);
  const feature = path.join(worktree, "feature.txt");
  fs.writeFileSync(feature, "committed feature\n");
  fixture.git(worktree, "add", "feature.txt");
  fixture.git(worktree, "commit", "-m", "feature");

  const mainHead = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  const worktreeHead = fixture.git(worktree, "rev-parse", "HEAD").trim();
  const branchHead = fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim();
  const worktrees = ws.listWorktrees(fixture.repo);
  const binding = loadBindings()[sessionId];
  const meta = await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json();

  const response = await fixture.post(`/api/sessions/${sessionId}/merge`);
  assert.equal(response.status, 404);
  assert.equal(fixture.git(fixture.repo, "rev-parse", "HEAD").trim(), mainHead);
  assert.equal(fixture.git(worktree, "rev-parse", "HEAD").trim(), worktreeHead);
  assert.equal(fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim(), branchHead);
  assert.equal(fs.readFileSync(feature, "utf8"), "committed feature\n");
  assert.deepEqual(ws.listWorktrees(fixture.repo), worktrees);
  assert.deepEqual(loadBindings()[sessionId], binding);
  assert.deepEqual(await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json(), meta);
});
