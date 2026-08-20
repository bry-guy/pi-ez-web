import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as ws from "../server/workspaces.js";

let tmp, repo, wtRoot;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-ws-"));
  repo = path.join(tmp, "repo");
  wtRoot = path.join(tmp, "worktrees");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("repo detection and branch listing", () => {
  assert.equal(ws.isGitRepo(repo), true);
  assert.equal(ws.isGitRepo(tmp), false);
  assert.equal(ws.currentBranch(repo), "main");
  assert.deepEqual(ws.listBranches(repo), ["main"]);
  assert.deepEqual(ws.listRemoteBranches(repo), []);
});

test("remote branch listing preserves remote names and supports local mapping", () => {
  git(repo, "update-ref", "refs/remotes/origin/feature/remote-ui", "HEAD");
  assert.deepEqual(ws.listRemoteBranches(repo), ["origin/feature/remote-ui"]);
  assert.equal(ws.localBranchForRemote("origin/feature/remote-ui"), "feature/remote-ui");
  assert.equal(ws.remoteBranchForLocal(repo, "feature/remote-ui"), "origin/feature/remote-ui");
});

test("worktree status reports checkout state and pull surfaces Git failures", () => {
  assert.deepEqual(ws.workspaceStatus({ repoPath: repo, branch: "main", workspacePath: repo }), {
    branch: "main", path: repo, kind: "checkout", dirty: false, upstream: null, ahead: 0, behind: 0,
  });
  assert.throws(() => ws.pullWorkspace(repo), error => error?.code === "git_pull_failed");
});

test("worktree map includes the checkout", () => {
  assert.deepEqual(ws.listWorktrees(repo), { main: repo });
});

test("ensureWorkspace creates a worktree for a new branch without touching the checkout", () => {
  const wt = ws.ensureWorkspace({ repoPath: repo, worktreeRoot: wtRoot, projectId: "p1", branch: "feat/x" });
  assert.ok(fs.existsSync(path.join(wt, "a.txt")));
  assert.equal(ws.currentBranch(wt), "feat/x");
  assert.equal(ws.currentBranch(repo), "main"); // checkout untouched
  assert.equal(ws.listWorktrees(repo)["feat/x"], wt);
  // idempotent
  assert.equal(ws.ensureWorkspace({ repoPath: repo, worktreeRoot: wtRoot, projectId: "p1", branch: "feat/x" }), wt);
});

test("git refuses the same branch in two worktrees (the invariant we lean on)", () => {
  assert.throws(() => git(repo, "worktree", "add", path.join(tmp, "dup"), "feat/x"));
});

test("forkWorkspace carries dirty state to the fork AND restores it in the parent", () => {
  const parent = ws.listWorktrees(repo)["feat/x"];
  fs.writeFileSync(path.join(parent, "a.txt"), "one\nmodified\n");   // tracked change
  fs.writeFileSync(path.join(parent, "untracked.txt"), "new file\n"); // untracked
  const { branch, workspacePath } = ws.forkWorkspace({
    repoPath: repo, worktreeRoot: wtRoot, projectId: "p1",
    parentWorkspace: parent, parentBranch: "feat/x",
    existingBranches: ws.listBranches(repo),
  });
  assert.equal(branch, "branch/x-1");
  // fork got both
  assert.equal(fs.readFileSync(path.join(workspacePath, "a.txt"), "utf8"), "one\nmodified\n");
  assert.equal(fs.readFileSync(path.join(workspacePath, "untracked.txt"), "utf8"), "new file\n");
  // parent still dirty in the same way
  assert.equal(fs.readFileSync(path.join(parent, "a.txt"), "utf8"), "one\nmodified\n");
  assert.ok(fs.existsSync(path.join(parent, "untracked.txt")));
  assert.equal(ws.isDirty(parent), true);
  assert.equal(ws.isDirty(workspacePath), true);
});

test("fork numbering avoids collisions", () => {
  const parent = ws.listWorktrees(repo)["feat/x"];
  const { branch } = ws.forkWorkspace({
    repoPath: repo, worktreeRoot: wtRoot, projectId: "p1",
    parentWorkspace: parent, parentBranch: "feat/x",
    existingBranches: ws.listBranches(repo),
  });
  assert.equal(branch, "branch/x-2");
});

test("clean-parent fork works (no stash cycle)", () => {
  const main = repo;
  git(main, "stash", "list"); // sanity: callable
  const { workspacePath } = ws.forkWorkspace({
    repoPath: repo, worktreeRoot: wtRoot, projectId: "p1",
    parentWorkspace: main, parentBranch: "main",
    existingBranches: ws.listBranches(repo),
  });
  assert.ok(fs.existsSync(path.join(workspacePath, "a.txt")));
});

test("dirty checkout fork is refused before stash mutation", () => {
  const marker = path.join(repo, "checkout-local.txt");
  fs.writeFileSync(marker, "local\n");
  assert.throws(
    () => ws.forkWorkspace({
      repoPath: repo, worktreeRoot: wtRoot, projectId: "p1",
      parentWorkspace: repo, parentBranch: "main", existingBranches: ws.listBranches(repo),
    }),
    err => err?.code === "checkout_dirty",
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "local\n");
  fs.rmSync(marker);
});

test("removeWorkspace refuses dirty, force removes", () => {
  const dirtyWt = ws.listWorktrees(repo)["branch/x-1"];
  assert.throws(() => ws.removeWorkspace({ repoPath: repo, workspacePath: dirtyWt }), /workspace_dirty/);
  ws.removeWorkspace({ repoPath: repo, workspacePath: dirtyWt, force: true });
  assert.equal(ws.listWorktrees(repo)["branch/x-1"], undefined);
});

test("fileTree sorts directories first and keeps full relative paths", () => {
  fs.mkdirSync(path.join(repo, ".config", "deep"), { recursive: true });
  fs.mkdirSync(path.join(repo, "zdir"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".config", "deep", "f.txt"), "");
  fs.writeFileSync(path.join(repo, "zdir", "f.txt"), "");
  const tree = ws.fileTree(repo);
  assert.equal(tree[0].n, ".config");
  assert.ok(tree.some(n => n.n === "a.txt" && !n.c));
  assert.ok(tree.some(n => n.p === ".config" && n.c?.some(child => child.p === ".config/deep")));
  assert.equal(tree.some(n => n.n === ".git"), false);
  assert.equal(tree.some(n => n.n === "node_modules"), false);
});
