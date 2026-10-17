import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { highlightedLines, readFileTree, readFileView } from "../server/file-explorer.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const commit = (cwd, message) => { git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", message); };
const statuses = (nodes, out = new Map()) => {
  for (const node of nodes) {
    if (node.c) statuses(node.c, out);
    else if (node.s) out.set(node.p, node.s);
  }
  return out;
};

test("diff targets compare against the upstream or the merge-base with the primary branch", () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-"));
  git(remote, "init", "-q", "--bare");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", remote);
  write(repo, "README.md", "one\n");
  commit(repo, "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "feat.txt", "feat\n");
  commit(repo, "feat");

  const noUpstream = readFileView({ workspace: repo, repoPath: repo, path: "feat.txt" });
  assert.equal(noUpstream.target, "origin", "vs origin is the default");
  assert.deepEqual(noUpstream.targets, ["origin", "primary"]);
  assert.equal(noUpstream.diff.label, "vs main (no upstream)", "the fallback base is labelled");
  assert.equal(statuses(readFileTree({ workspace: repo, repoPath: repo }).tree).get("feat.txt"), "new");

  git(repo, "push", "-q", "-u", "origin", "feat");
  assert.equal(statuses(readFileTree({ workspace: repo, repoPath: repo }).tree).has("feat.txt"), false, "vs origin ignores commits already pushed");
  assert.equal(statuses(readFileTree({ workspace: repo, repoPath: repo, target: "primary" }).tree).get("feat.txt"), "new", "vs main includes the branch commits");

  write(repo, "README.md", "two\n");
  write(repo, "new.txt", "new\n");
  const tree = readFileTree({ workspace: repo, repoPath: repo, target: "origin" }).tree;
  assert.equal(statuses(tree).get("README.md"), "modified");
  assert.equal(statuses(tree).get("new.txt"), "new", "untracked files are listed against the upstream");
  const view = readFileView({ workspace: repo, repoPath: repo, path: "README.md", target: "primary" });
  assert.equal(view.diff.label, "vs main");
  assert.ok(view.diff.lines.some(line => line.sign === "+" && line.text === "two"));
  assert.throws(() => readFileTree({ workspace: repo, repoPath: repo, target: "none" }), error => error?.code === "invalid_diff_target");
});

test("Dockerfiles are highlighted and dot-names sort first among folders and files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-highlight-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, "Dockerfile", "FROM node:22\nRUN npm ci\n");
  write(repo, "app.js", "const a = 1;\n");
  write(repo, ".env.example", "A=1\n");
  fs.mkdirSync(path.join(repo, ".github"));
  write(repo, ".github/ci.yml", "a: 1\n");
  fs.mkdirSync(path.join(repo, "src"));
  write(repo, "src/index.js", "x\n");
  commit(repo, "init");

  const view = readFileView({ workspace: repo, repoPath: repo, path: "Dockerfile" });
  assert.equal(view.language, "dockerfile");
  assert.match(view.highlighted, /hljs-keyword/, "dockerfile keywords are tokenised");

  const names = readFileTree({ workspace: repo, repoPath: repo }).tree.map(node => node.n);
  assert.deepEqual(names, [".github", "src", ".env.example", "app.js", "Dockerfile"]);
});

test("highlighted lines stand alone when a span crosses a line break", () => {
  const lines = highlightedLines('<span class="hljs-comment">/* a\nb */</span> x\ny');
  assert.deepEqual(lines, ['<span class="hljs-comment">/* a</span>', '<span class="hljs-comment">b */</span> x', "y"]);
});

test("diff lines carry highlighted HTML from the old and new file", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-highlight-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, "app.js", "/* note\n   more */\nconst a = 1;\nconst s = \"<b>\";\n");
  commit(repo, "init");
  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "app.js", "/* note\n   more */\nlet a = 2;\nconst s = \"<b>\";\n");
  write(repo, "fresh.js", "const fresh = true;\n");

  const view = readFileView({ workspace: repo, repoPath: repo, path: "app.js", target: "primary" });
  const removed = view.diff.lines.find(line => line.sign === "-");
  const added = view.diff.lines.find(line => line.sign === "+");
  const context = view.diff.lines.filter(line => line.sign === " ");
  assert.equal(removed.text, "const a = 1;");
  assert.match(removed.html, /<span class="hljs-keyword">const<\/span>/, "removed lines are highlighted from the base version");
  assert.match(added.html, /<span class="hljs-keyword">let<\/span>/, "added lines are highlighted from the working file");
  assert.match(context.find(line => line.text === "   more */").html, /^<span class="hljs-comment">/, "a multi-line comment stays a comment on its later lines");
  assert.match(context.find(line => line.text.includes("<b>")).html, /&lt;b&gt;/, "highlighted text stays escaped");
  assert.equal(view.diff.lines.some(line => "oldNo" in line || "newNo" in line), false);

  const untracked = readFileView({ workspace: repo, repoPath: repo, path: "fresh.js", target: "primary" });
  assert.match(untracked.diff.lines[1].html, /hljs-keyword/, "new files are highlighted too");
});
