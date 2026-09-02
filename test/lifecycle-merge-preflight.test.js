import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge preflight: dirty checkout is refused", async () => {
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession("feat/co-dirty");
  fs.writeFileSync(path.join(worktree, "ok.txt"), "ok\n");
  fixture.git(worktree, "add", "-A");
  fixture.git(worktree, "commit", "-m", "ok");
  fs.writeFileSync(path.join(fixture.repo, "local-edit.txt"), "user was here\n");

  const response = await fixture.post(`/api/sessions/${sessionId}/merge`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "checkout_dirty");
  fs.rmSync(path.join(fixture.repo, "local-edit.txt"));
  await fixture.post(`/api/sessions/${sessionId}/close`);
});
