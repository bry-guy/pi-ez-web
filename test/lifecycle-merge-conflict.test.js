import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge conflict: aborted cleanly — checkout restored, branch and worktree untouched", async () => {
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession("feat/conflict");
  fs.writeFileSync(path.join(worktree, "README.md"), "branch version\n");
  fixture.git(worktree, "add", "-A");
  fixture.git(worktree, "commit", "-m", "branch side");
  fs.writeFileSync(path.join(fixture.repo, "README.md"), "main version\n");
  fixture.git(fixture.repo, "add", "-A");
  fixture.git(fixture.repo, "commit", "-m", "main side");

  const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "merge_conflict");
  assert.equal(fixture.git(fixture.repo, "status", "--porcelain").trim(), "");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "README.md"), "utf8"), "main version\n");
  assert.match(fixture.git(fixture.repo, "branch", "--list"), /feat\/conflict/);
  assert.ok(fs.existsSync(worktree));
  const meta = await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json();
  assert.equal(meta.cwd, worktree);
  await fixture.post(`/api/sessions/${sessionId}/close`);
});
