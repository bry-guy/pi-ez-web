import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

async function withFailingV2Status(callback) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-v2-failure-"));
  const bin = path.join(tmp, "bin");
  const tracePath = path.join(tmp, "git-trace");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const keys = ["PATH", "PI_TEST_GIT_REAL", "PI_TEST_GIT_TRACE"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PI_TEST_GIT_TRACE"
if [ "$1" = "status" ] && [ "$2" = "--porcelain=v2" ]; then
  printf '%s\\n' 'injected v2 status failure' >&2
  exit 42
fi
exec "$PI_TEST_GIT_REAL" "$@"
`);
  fs.chmodSync(path.join(bin, "git"), 0o700);
  fs.writeFileSync(tracePath, "");
  process.env.PATH = `${bin}${path.delimiter}${saved.get("PATH") || "/usr/bin:/bin"}`;
  process.env.PI_TEST_GIT_REAL = realGit;
  process.env.PI_TEST_GIT_TRACE = tracePath;
  try {
    await callback(tracePath);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function gitTrace(tracePath) {
  const contents = fs.readFileSync(tracePath, "utf8").trim();
  return contents ? contents.split(/\r?\n/) : [];
}

test("contextStatus preserves worktree records without Git reads after v2 status fails", async () => {
  const fixture = createWorkspaceFixture();
  try {
    fixture.git(fixture.repo, "switch", "-c", "feature/context-status");
    fs.mkdirSync(fixture.wtRoot, { recursive: true });
    const mainWorktree = path.join(fixture.wtRoot, "main");
    const detachedWorktree = path.join(fixture.wtRoot, "detached");
    fixture.git(fixture.repo, "worktree", "add", mainWorktree, "main");
    fixture.git(fixture.repo, "worktree", "add", "--detach", detachedWorktree, "HEAD");

    const records = ws.listWorktreeRecords(fixture.repo);
    assert.equal(records.length, 3);

    await withFailingV2Status(async tracePath => {
      for (const record of records) assert.equal(fixture.git(record.path, "status", "--porcelain"), "");
      fs.writeFileSync(tracePath, "");
      for (const record of records) {
        fs.writeFileSync(tracePath, "");
        const context = ws.contextStatus({
          repoPath: fixture.repo,
          workspacePath: record.path,
          record,
          primaryBranch: "main",
        });
        const kind = path.resolve(record.path) === path.resolve(fixture.repo) ? "checkout" : "worktree";
        const externalMain = record.branch === "main" && kind === "worktree";
        assert.equal(context.id, ws.contextId(fixture.repo, record.path));
        assert.equal(context.path, record.path);
        assert.equal(context.kind, kind);
        assert.equal(context.branch, record.branch);
        assert.equal(context.head, record.head);
        assert.equal(context.detached, record.detached);
        assert.equal(context.primaryBranch, "main");
        assert.equal(context.externalMain, externalMain);
        assert.equal(context.protected, externalMain);
        assert.equal(context.status, "unknown");
        assert.equal(context.dirty, null);
        assert.equal(context.statusDetails, null);
        assert.equal(context.commit, null);
        assert.equal(context.upstream, null);
        assert.equal(context.ahead, null);
        assert.equal(context.behind, null);
        assert.match(context.statusError, /injected v2 status failure/);
        assert.ok(context.statusError.length <= 400);
        assert.deepEqual(gitTrace(tracePath), ["status --porcelain=v2 --branch"]);
      }
    });

    const checkoutRecord = records.find(record => record.path === fixture.repo);
    const normal = ws.contextStatus({
      repoPath: fixture.repo,
      workspacePath: fixture.repo,
      record: checkoutRecord,
      primaryBranch: "main",
    });
    assert.equal(normal.kind, "checkout");
    assert.equal(normal.branch, checkoutRecord.branch);
    assert.equal(normal.head, checkoutRecord.head);
    assert.equal(normal.dirty, false);
    assert.equal(normal.status, "clean");
    assert.deepEqual(normal.statusDetails, { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
    assert.equal(normal.statusError, null);
  } finally {
    fixture.close();
  }
});

test("merge-local rejects failed v2 status without mutating the worktree", async () => {
  const fixture = await createIsolatedServerFixture();
  try {
    const { sessionId, workspacePath } = await fixture.createWorktreeSession("feature/merge-status");
    const preservedFile = path.join(workspacePath, "preserved.txt");
    fs.writeFileSync(preservedFile, "preserve this commit\n");
    fixture.git(workspacePath, "add", "preserved.txt");
    fixture.git(workspacePath, "commit", "-m", "preserve worktree file");
    const worktreeHead = fixture.git(workspacePath, "rev-parse", "HEAD").trim();
    const checkoutHead = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
    const files = fs.readdirSync(workspacePath).sort();
    const worktrees = fixture.git(fixture.repo, "worktree", "list", "--porcelain");

    await withFailingV2Status(async tracePath => {
      const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "git_status_unavailable");
      const commands = gitTrace(tracePath);
      assert.ok(commands.includes("status --porcelain=v2 --branch"));
      assert.equal(commands.some(command => command === "status --porcelain" || command.startsWith("status --porcelain ")), false);
      assert.deepEqual(commands.filter(command => /^(merge|switch|reset|rebase|cherry-pick|worktree remove|branch -D)(?:\s|$)/.test(command)), []);
    });

    assert.equal(fs.existsSync(workspacePath), true);
    assert.deepEqual(fs.readdirSync(workspacePath).sort(), files);
    assert.equal(fs.readFileSync(preservedFile, "utf8"), "preserve this commit\n");
    assert.equal(fixture.git(workspacePath, "rev-parse", "HEAD").trim(), worktreeHead);
    assert.equal(fixture.git(fixture.repo, "rev-parse", "HEAD").trim(), checkoutHead);
    assert.equal(fixture.git(fixture.repo, "worktree", "list", "--porcelain"), worktrees);
  } finally {
    await fixture.close();
  }
});
