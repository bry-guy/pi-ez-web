import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge: lands work into the checkout, cleans up, session continues on the default branch", async () => {
  const { sessionId, workspacePath: worktree } = await fixture.createWorktreeSession("feat/ship");
  fs.writeFileSync(path.join(worktree, "feature.txt"), "shipped\n");
  fixture.git(worktree, "add", "-A");
  fixture.git(worktree, "commit", "-m", "feature");

  const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.merged, "feat/ship");
  assert.equal(body.into, "main");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "feature.txt"), "utf8"), "shipped\n");
  assert.match(fixture.git(fixture.repo, "log", "-1", "--format=%s"), /feat\/ship/);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fixture.git(fixture.repo, "branch", "--list", "feat/ship").trim(), "");
  const meta = await (await fixture.get(`/api/sessions/${sessionId}/meta`)).json();
  assert.equal(meta.cwd, fixture.repo);

  await fixture.post(`/api/sessions/${sessionId}/message`, { text: "hello from main" });
  await fixture.post(`/api/sessions/${sessionId}/stop`);
});
