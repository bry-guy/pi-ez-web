import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createWorkspaceFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-ws-"));
  const repo = path.join(tmp, "repo");
  const wtRoot = path.join(tmp, "worktrees");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return {
    tmp,
    repo,
    wtRoot,
    git,
    close: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
