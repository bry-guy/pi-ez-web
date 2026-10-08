import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";
import * as ws from "../server/workspaces.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-status-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "initial");
  git(repo, "worktree", "add", "-b", "feature", worktree);
  return { root, repo, worktree, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function failGitStatus({ worktree }) {
  const index = git(worktree, "rev-parse", "--git-path", "index").trim();
  fs.writeFileSync(path.isAbsolute(index) ? index : path.resolve(worktree, index), "corrupt index\n");
  assert.throws(() => git(worktree, "status", "--porcelain"), error => Number.isInteger(error.status) && error.status !== 0);
}

test("isDirty reports clean, tracked-dirty, and untracked worktrees", () => {
  const fixture = createWorktree();
  try {
    assert.equal(ws.isDirty(fixture.worktree), false);
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "modified\n");
    assert.equal(ws.isDirty(fixture.worktree), true);
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "initial\n");
    fs.writeFileSync(path.join(fixture.worktree, "untracked.txt"), "untracked\n");
    assert.equal(ws.isDirty(fixture.worktree), true);
  } finally {
    fixture.close();
  }
});

test("isDirty reports Git status failures as unavailable", () => {
  const fixture = createWorktree();
  try {
    failGitStatus(fixture);
    assert.throws(() => ws.isDirty(fixture.worktree), error =>
      error.code === "git_status_unavailable" && typeof error.detail === "string" && error.detail.length > 0,
    );
  } finally {
    fixture.close();
  }
});

test("nonforce removal rejects unavailable status without removing worktree files", () => {
  const fixture = createWorktree();
  const marker = path.join(fixture.worktree, "keep.txt");
  try {
    fs.writeFileSync(marker, "keep\n");
    const files = fs.readdirSync(fixture.worktree).sort();
    failGitStatus(fixture);
    assert.equal(ws.workspaceStatus({ repoPath: fixture.repo, workspacePath: fixture.worktree }).dirty, null);
    const context = ws.contextStatus({ repoPath: fixture.repo, workspacePath: fixture.worktree });
    assert.equal(context.dirty, null);
    assert.equal(context.status, "unknown");
    assert.throws(
      () => git(fixture.repo, "worktree", "remove", fixture.worktree),
      error => Number.isInteger(error.status) && error.status !== 0,
    );
    assert.throws(
      () => ws.removeWorkspace({ repoPath: fixture.repo, workspacePath: fixture.worktree }),
      error => error.code === "git_status_unavailable",
    );
    assert.equal(fs.existsSync(fixture.worktree), true);
    assert.deepEqual(fs.readdirSync(fixture.worktree).sort(), files);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, "tracked.txt"), "utf8"), "initial\n");
    assert.equal(fs.readFileSync(marker, "utf8"), "keep\n");
    assert.ok(git(fixture.repo, "worktree", "list", "--porcelain").includes(fixture.worktree));
  } finally {
    fixture.close();
  }
});

test("switch routes map unavailable Git status to a conflict", async () => {
  const fixture = await createIsolatedServerFixture();
  try {
    const { sessionId, workspacePath } = await fixture.createWorktreeSession("feature");
    fixture.git(fixture.repo, "branch", "other");
    failGitStatus({ worktree: workspacePath });
    const branchResponse = await fixture.post(`/api/sessions/${sessionId}/switch`, { branch: "other" });
    assert.equal(branchResponse.status, 409);
    assert.equal((await branchResponse.json()).error, "git_status_unavailable");

    fixture.git(fixture.repo, "switch", "-c", "away");
    failGitStatus({ worktree: fixture.repo });
    const checkoutResponse = await fixture.post(`/api/sessions/${fixture.mainSessionId}/switch`, { branch: "main" });
    assert.equal(checkoutResponse.status, 409);
    assert.equal((await checkoutResponse.json()).error, "git_status_unavailable");
  } finally {
    await fixture.close();
  }
});

test("explicit force removal bypasses the dirty-status guard", () => {
  const fixture = createWorktree();
  try {
    failGitStatus(fixture);
    ws.removeWorkspace({ repoPath: fixture.repo, workspacePath: fixture.worktree, force: true });
    assert.equal(fs.existsSync(fixture.worktree), false);
    assert.equal(git(fixture.repo, "worktree", "list", "--porcelain").includes(fixture.worktree), false);
  } finally {
    fixture.close();
  }
});
