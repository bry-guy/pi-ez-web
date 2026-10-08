import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadBindings } from "../server/config.js";
import * as ws from "../server/workspaces.js";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function createMergeSource(branch) {
  const { sessionId, workspacePath } = await fixture.createWorktreeSession(branch);
  const featurePath = path.join(workspacePath, "feature.txt");
  fs.writeFileSync(featurePath, "committed feature\n");
  fixture.git(workspacePath, "add", "feature.txt");
  fixture.git(workspacePath, "commit", "-m", "feature");
  assert.equal(fixture.git(fixture.repo, "branch", "--show-current").trim(), "main");
  assert.throws(() => fixture.git(fixture.repo, "rev-parse", "--abbrev-ref", "main@{upstream}"));
  return { branch, sessionId, workspacePath, featurePath };
}

async function captureMergeState({ branch, sessionId, workspacePath, featurePath }) {
  const meta = await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json();
  return {
    mainHead: fixture.git(fixture.repo, "rev-parse", "refs/heads/main").trim(),
    sourceHead: fixture.git(fixture.repo, "rev-parse", `refs/heads/${branch}`).trim(),
    checkoutStatus: fixture.git(fixture.repo, "status", "--short"),
    sourceStatus: fixture.git(workspacePath, "status", "--short"),
    worktrees: ws.listWorktrees(fixture.repo),
    binding: loadBindings()[sessionId],
    cwd: meta.cwd,
    feature: fs.readFileSync(featurePath, "utf8"),
  };
}

async function assertMergeRefusedWithoutMutation(source, before, error, { statusAvailable = true } = {}) {
  const response = await fixture.post(`/api/sessions/${source.sessionId}/merge-local`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, error);
  assert.equal(fixture.git(fixture.repo, "branch", "--show-current").trim(), "main");
  assert.equal(fixture.git(fixture.repo, "rev-parse", "refs/heads/main").trim(), before.mainHead);
  assert.equal(fixture.git(fixture.repo, "rev-parse", `refs/heads/${source.branch}`).trim(), before.sourceHead);
  assert.equal(fs.existsSync(source.workspacePath), true);
  assert.equal(fs.readFileSync(source.featurePath, "utf8"), before.feature);
  assert.equal(fixture.git(source.workspacePath, "status", "--short"), before.sourceStatus);
  assert.deepEqual(ws.listWorktrees(fixture.repo), before.worktrees);
  assert.deepEqual(loadBindings()[source.sessionId], before.binding);
  assert.equal((await (await fixture.get(`/api/sessions/${source.sessionId}/meta`)).json()).cwd, before.cwd);
  if (statusAvailable) assert.equal(fixture.git(fixture.repo, "status", "--short"), before.checkoutStatus);
}

test("merge preflight refuses tracked primary-checkout changes without mutation", async () => {
  const source = await createMergeSource("feat/checkout-tracked-dirty");
  const tracked = path.join(fixture.repo, "README.md");
  fs.writeFileSync(tracked, "primary local edit\n");
  const before = await captureMergeState(source);

  await assertMergeRefusedWithoutMutation(source, before, "checkout_dirty");
  assert.equal(fs.readFileSync(tracked, "utf8"), "primary local edit\n");
});

test("merge preflight refuses untracked primary-checkout changes without mutation", async () => {
  const source = await createMergeSource("feat/checkout-untracked-dirty");
  const untracked = path.join(fixture.repo, "primary-local.txt");
  fs.writeFileSync(untracked, "user was here\n");
  const before = await captureMergeState(source);

  await assertMergeRefusedWithoutMutation(source, before, "checkout_dirty");
  assert.equal(fs.readFileSync(untracked, "utf8"), "user was here\n");
});

test("merge preflight refuses unavailable primary Git status without mutation", async () => {
  const source = await createMergeSource("feat/checkout-status-unavailable");
  const before = await captureMergeState(source);
  const gitIndex = fixture.git(fixture.repo, "rev-parse", "--git-path", "index").trim();
  const indexPath = path.isAbsolute(gitIndex) ? gitIndex : path.resolve(fixture.repo, gitIndex);
  const originalIndex = fs.readFileSync(indexPath);
  fs.writeFileSync(indexPath, "corrupt index\n");
  assert.throws(() => fixture.git(fixture.repo, "status", "--porcelain"), error => Number.isInteger(error.status) && error.status !== 0);

  try {
    await assertMergeRefusedWithoutMutation(source, before, "git_status_unavailable", { statusAvailable: false });
  } finally {
    fs.writeFileSync(indexPath, originalIndex);
  }
  assert.equal(fixture.git(fixture.repo, "status", "--short"), before.checkoutStatus);
});
