import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloneRepository, parsePublicGitUrl } from "../server/repositories.js";

function fakeGithub() {
  return {
    effectiveAuth: () => ({ accessToken: "gho_secret-token" }),
    async repository(fullName) {
      assert.equal(fullName, "bry-guy/private-repo");
      return { name: "private-repo", fullName, cloneUrl: "https://github.com/bry-guy/private-repo.git" };
    },
  };
}

test("public Git URL validation rejects credentials and non-HTTPS schemes", () => {
  assert.equal(parsePublicGitUrl("https://example.test/a/repo.git?download=1"), "https://example.test/a/repo.git");
  assert.throws(() => parsePublicGitUrl("http://example.test/a/repo.git"), error => error.code === "invalid_git_url");
  assert.throws(() => parsePublicGitUrl("ssh://git@example.test/a/repo.git"), error => error.code === "invalid_git_url");
  assert.throws(() => parsePublicGitUrl("https://user:password@example.test/a/repo.git"), error => error.code === "invalid_git_url");
});

test("GitHub clone uses askpass environment, not URL or argv", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-"));
  let call;
  try {
    const result = await cloneRepository({
      source: "github",
      fullName: "bry-guy/private-repo",
      github: fakeGithub(),
      root: tmp,
      runGit: async (_file, args, options) => {
        call = { args, options };
        const destination = args.at(-1);
        fs.writeFileSync(path.join(destination, "README.md"), "cloned\n");
      },
    });
    assert.equal(result.repoPath, path.join(tmp, "private-repo"));
    assert.equal(fs.readFileSync(path.join(result.repoPath, "README.md"), "utf8"), "cloned\n");
    assert.ok(call.options.env.GIT_ASKPASS);
    assert.equal(call.options.env.PI_WEB_GIT_TOKEN, "gho_secret-token");
    assert.doesNotMatch(call.args.join(" "), /gho_secret-token/);
    assert.doesNotMatch(call.args.join(" "), /user:password/);
    assert.equal(fs.existsSync(call.options.env.GIT_ASKPASS), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("clone failures remove temporary directories and preserve destination", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-fail-"));
  try {
    await assert.rejects(() => cloneRepository({
      source: "git-url",
      url: "https://example.test/repo.git",
      root: tmp,
      runGit: async () => { throw new Error("fatal: authentication token=secret"); },
    }), error => error.code === "clone_failed");
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("existing repository destinations are never overwritten", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-existing-"));
  const existing = path.join(tmp, "repo");
  try {
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "keep.txt"), "keep\n");
    await assert.rejects(() => cloneRepository({ source: "git-url", url: "https://example.test/repo.git", root: tmp, runGit: async () => {} }), error => error.code === "repository_exists");
    assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
