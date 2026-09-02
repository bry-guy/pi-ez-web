import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as ws from "../server/workspaces.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

let fixture;
let featureWorktree;
let dirtyWorktree;

before(() => {
  fixture = createWorkspaceFixture();
  featureWorktree = ws.ensureWorkspace({ repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1", branch: "feat/x" });
});

after(() => {
  fixture?.close();
  fixture = undefined;
  featureWorktree = undefined;
  dirtyWorktree = undefined;
});

test("main is checkout-only and external main worktrees are protected", () => {
  assert.throws(() => ws.ensureWorkspace({ repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1", branch: "main" }), error => error?.code === "main_worktree_forbidden");
  assert.throws(() => ws.forkWorkspace({
    repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1", parentWorkspace: featureWorktree, parentBranch: "feat/x",
    existingBranches: ws.listBranches(fixture.repo), branch: "main",
  }), error => error?.code === "main_worktree_forbidden");

  fixture.git(fixture.repo, "switch", "-c", "checkout-away");
  const external = path.join(fixture.tmp, "external-main");
  fixture.git(fixture.repo, "worktree", "add", external, "main");
  assert.equal(ws.workspaceStatus({ repoPath: fixture.repo, branch: "main", workspacePath: external }).externalMain, true);
  assert.throws(() => ws.removeWorkspace({ repoPath: fixture.repo, workspacePath: external, force: true }), error => error?.code === "main_worktree_external");
  assert.throws(() => ws.switchWorkspace({ repoPath: fixture.repo, workspacePath: featureWorktree, branch: "main" }), error => error?.code === "main_worktree_forbidden");
  fixture.git(fixture.repo, "worktree", "remove", external);
  fixture.git(fixture.repo, "switch", "main");
  fixture.git(fixture.repo, "branch", "-D", "checkout-away");
});

test("git refuses the same branch in two worktrees (the invariant we lean on)", () => {
  assert.throws(() => fixture.git(fixture.repo, "worktree", "add", path.join(fixture.tmp, "dup"), "feat/x"));
});

test("forkWorkspace carries dirty state to the fork AND restores it in the parent", () => {
  const parent = featureWorktree;
  fs.writeFileSync(path.join(parent, "a.txt"), "one\nmodified\n");
  fs.writeFileSync(path.join(parent, "untracked.txt"), "new file\n");
  const fork = ws.forkWorkspace({
    repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1",
    parentWorkspace: parent, parentBranch: "feat/x", existingBranches: ws.listBranches(fixture.repo),
  });
  dirtyWorktree = fork.workspacePath;
  assert.equal(fork.branch, "branch/x-1");
  assert.equal(fs.readFileSync(path.join(fork.workspacePath, "a.txt"), "utf8"), "one\nmodified\n");
  assert.equal(fs.readFileSync(path.join(fork.workspacePath, "untracked.txt"), "utf8"), "new file\n");
  assert.equal(fs.readFileSync(path.join(parent, "a.txt"), "utf8"), "one\nmodified\n");
  assert.ok(fs.existsSync(path.join(parent, "untracked.txt")));
  assert.equal(ws.isDirty(parent), true);
  assert.equal(ws.isDirty(fork.workspacePath), true);
});

test("fork numbering avoids collisions", () => {
  const parent = featureWorktree;
  const { branch } = ws.forkWorkspace({
    repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1",
    parentWorkspace: parent, parentBranch: "feat/x", existingBranches: ws.listBranches(fixture.repo),
  });
  assert.equal(branch, "branch/x-2");
});

test("clean-parent fork works (no stash cycle)", () => {
  fixture.git(fixture.repo, "stash", "list");
  const { workspacePath } = ws.forkWorkspace({
    repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1",
    parentWorkspace: fixture.repo, parentBranch: "main", existingBranches: ws.listBranches(fixture.repo),
  });
  assert.ok(fs.existsSync(path.join(workspacePath, "a.txt")));
});

test("dirty checkout fork is refused before stash mutation", () => {
  const marker = path.join(fixture.repo, "checkout-local.txt");
  fs.writeFileSync(marker, "local\n");
  assert.throws(
    () => ws.forkWorkspace({
      repoPath: fixture.repo, worktreeRoot: fixture.wtRoot, projectId: "p1",
      parentWorkspace: fixture.repo, parentBranch: "main", existingBranches: ws.listBranches(fixture.repo),
    }),
    error => error?.code === "checkout_dirty",
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "local\n");
  fs.rmSync(marker);
});

test("removeWorkspace refuses dirty, force removes", () => {
  assert.throws(() => ws.removeWorkspace({ repoPath: fixture.repo, workspacePath: dirtyWorktree }), /workspace_dirty/);
  ws.removeWorkspace({ repoPath: fixture.repo, workspacePath: dirtyWorktree, force: true });
  assert.equal(ws.listWorktrees(fixture.repo)["branch/x-1"], undefined);
});
