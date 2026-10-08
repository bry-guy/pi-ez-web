import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatusV2, parseWorktreeRecords } from "../server/git-parsers.js";

test("worktree parser keeps porcelain record order and fields", () => {
  const stdout = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /detached",
    "HEAD def456",
    "detached",
    "locked inspection",
    "prunable stale",
  ].join("\n");

  assert.deepEqual(parseWorktreeRecords(stdout), [
    { path: "/repo", head: "abc123", branch: "main", detached: false },
    { path: "/detached", head: "def456", branch: null, detached: true },
  ]);
});

test("porcelain-v2 parser keeps branch metadata and dirty counters", () => {
  const stdout = [
    "# branch.oid abc123",
    "# branch.head feature/topic",
    "# branch.upstream origin/feature/topic",
    "# branch.ab +2 -3",
    "1 M. N... 100644 100644 100644 a a staged.txt",
    "1 .M N... 100644 100644 100644 b b unstaged.txt",
    "? untracked.txt",
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
    "! ignored.txt",
  ].join("\n");

  assert.deepEqual(parseStatusV2(stdout), {
    branch: "feature/topic",
    head: "abc123",
    upstream: "origin/feature/topic",
    ahead: 2,
    behind: 3,
    details: { total: 4, staged: 1, unstaged: 1, untracked: 1, conflicts: 1 },
  });
  assert.deepEqual(parseStatusV2("# branch.oid (initial)\n# branch.head (detached)\n"), {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    details: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  });
  assert.deepEqual(parseStatusV2("# branch.ab unknown nope\r\n2 R. N... 100644 100644 100644 hash hash R100 old.txt\tnew.txt\r\n"), {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    details: { total: 1, staged: 1, unstaged: 0, untracked: 0, conflicts: 0 },
  });
});
