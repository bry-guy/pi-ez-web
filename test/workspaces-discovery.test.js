import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as ws from "../server/workspaces.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

let fixture;

before(() => {
  fixture = createWorkspaceFixture();
});

after(() => {
  fixture?.close();
  fixture = undefined;
});

test("repo detection and branch listing", () => {
  assert.equal(ws.isGitRepo(fixture.repo), true);
  assert.equal(ws.isGitRepo(fixture.tmp), false);
  assert.equal(ws.currentBranch(fixture.repo), "main");
  assert.equal(ws.defaultBranch(fixture.repo), "main");
  assert.deepEqual(ws.listBranches(fixture.repo), ["main"]);
  assert.deepEqual(ws.listRemoteBranches(fixture.repo), []);
});

test("master repositories use master as the primary checkout branch", () => {
  const masterRepo = path.join(fixture.tmp, "master-repo");
  const masterWorktrees = path.join(fixture.tmp, "master-worktrees");
  fs.mkdirSync(masterRepo);
  fixture.git(masterRepo, "init", "-b", "master");
  fixture.git(masterRepo, "config", "user.email", "t@t");
  fixture.git(masterRepo, "config", "user.name", "t");
  fs.writeFileSync(path.join(masterRepo, "README.md"), "master\n");
  fixture.git(masterRepo, "add", "-A");
  fixture.git(masterRepo, "commit", "-m", "init");

  assert.equal(ws.defaultBranch(masterRepo), "master");
  assert.throws(() => ws.ensureWorkspace({ repoPath: masterRepo, worktreeRoot: masterWorktrees, projectId: "p-master", branch: "master" }), error => error?.code === "main_worktree_forbidden");
  const feature = ws.ensureWorkspace({ repoPath: masterRepo, worktreeRoot: masterWorktrees, projectId: "p-master", branch: "feature/change" });
  assert.equal(ws.currentBranch(masterRepo), "master");
  assert.equal(ws.currentBranch(feature), "feature/change");
  assert.equal(ws.contextStatus({ repoPath: masterRepo, workspacePath: masterRepo }).primaryBranch, "master");
});

test("remote branch listing preserves remote names and supports local mapping", () => {
  fixture.git(fixture.repo, "update-ref", "refs/remotes/origin/feature/remote-ui", "HEAD");
  assert.deepEqual(ws.listRemoteBranches(fixture.repo), ["origin/feature/remote-ui"]);
  assert.equal(ws.localBranchForRemote("origin/feature/remote-ui"), "feature/remote-ui");
  assert.equal(ws.remoteBranchForLocal(fixture.repo, "feature/remote-ui"), "origin/feature/remote-ui");
});

test("worktree status reports checkout state and pull surfaces Git failures", () => {
  assert.deepEqual(ws.workspaceStatus({ repoPath: fixture.repo, branch: "main", workspacePath: fixture.repo }), {
    branch: "main", path: fixture.repo, kind: "checkout", dirty: false, upstream: null, ahead: 0, behind: 0, externalMain: false, protected: false,
  });
  assert.throws(() => ws.pullWorkspace(fixture.repo), error => error?.code === "git_pull_failed");
});

test("worktree map includes the checkout", () => {
  assert.deepEqual(ws.listWorktrees(fixture.repo), { main: fixture.repo });
});

test("ensureWorkspace creates a worktree for a new branch without touching the checkout", () => {
  const worktree = ws.ensureWorkspace({ repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1", branch: "feat/x" });
  assert.ok(fs.existsSync(path.join(worktree, "a.txt")));
  assert.equal(ws.currentBranch(worktree), "feat/x");
  assert.equal(ws.currentBranch(fixture.repo), "main");
  assert.equal(ws.ensureWorkspace({ repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1", branch: "feat/x" }), worktree);
});

test("Git contexts identify checkout and linked worktree by stable path IDs", () => {
  const contexts = ws.listContexts(fixture.repo);
  const checkout = contexts.find(context => context.path === fixture.repo);
  const worktree = contexts.find(context => context.branch === "feat/x");
  assert.equal(checkout?.kind, "checkout");
  assert.equal(checkout?.branch, "main");
  assert.equal(checkout?.status, "clean");
  assert.equal(checkout?.commit?.subject, "init");
  assert.deepEqual(checkout?.statusDetails, { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
  assert.equal(worktree?.kind, "worktree");
  assert.equal(ws.contextId(fixture.repo, worktree.path), worktree.id);
});

test("context status counts staged, unstaged, and untracked files", () => {
  const detailRepo = path.join(fixture.tmp, "detail-repo");
  fs.mkdirSync(detailRepo);
  fixture.git(detailRepo, "init", "-b", "main");
  fixture.git(detailRepo, "config", "user.email", "t@t");
  fixture.git(detailRepo, "config", "user.name", "t");
  fs.writeFileSync(path.join(detailRepo, "tracked.txt"), "one\n");
  fixture.git(detailRepo, "add", "-A");
  fixture.git(detailRepo, "commit", "-m", "Initial detail commit");
  fs.writeFileSync(path.join(detailRepo, "tracked.txt"), "one\ntwo\n");
  fixture.git(detailRepo, "add", "tracked.txt");
  fs.writeFileSync(path.join(detailRepo, "tracked.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(detailRepo, "untracked.txt"), "new\n");

  const context = ws.contextStatus({ repoPath: detailRepo, workspacePath: detailRepo });
  assert.equal(context.commit.subject, "Initial detail commit");
  assert.equal(context.commit.shortHash, context.commit.hash.slice(0, 7));
  assert.deepEqual(context.statusDetails, { total: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
});

test("fileTree sorts directories first and keeps full relative paths", () => {
  fs.mkdirSync(path.join(fixture.repo, ".config", "deep"), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, "zdir"), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, ".config", "deep", "f.txt"), "");
  fs.writeFileSync(path.join(fixture.repo, "zdir", "f.txt"), "");
  const tree = ws.fileTree(fixture.repo);
  assert.equal(tree[0].n, ".config");
  assert.ok(tree.some(node => node.n === "a.txt" && !node.c));
  assert.ok(tree.some(node => node.p === ".config" && node.c?.some(child => child.p === ".config/deep")));
  assert.equal(tree.some(node => node.n === ".git"), false);
  assert.equal(tree.some(node => node.n === "node_modules"), false);
});
