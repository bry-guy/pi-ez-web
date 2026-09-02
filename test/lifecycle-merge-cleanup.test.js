import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge force-cleans uncommitted worktree changes after explicit confirmation", async () => {
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession("feat/dirty-merge");
  fs.writeFileSync(path.join(worktree, "wip.txt"), "uncommitted\n");
  const response = await fixture.post(`/api/sessions/${sessionId}/merge`);
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, "wip.txt")), false);
});
