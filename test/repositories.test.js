import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloneRepository, parsePublicGitUrl } from "../server/repositories.js";

function fakeGithub({ token = "gho_secret-token", privateRepo = false } = {}) {
  return {
    effectiveAuth: () => token ? { accessToken: token } : null,
    async repository(fullName) {
      assert.equal(fullName, "bry-guy/private-repo");
      return { name: "private-repo", fullName, private: privateRepo, cloneUrl: "https://github.com/bry-guy/private-repo.git" };
    },
  };
}

async function withSyntheticEnvironment(overrides, callback) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: saved.PATH || "/usr/bin:/bin", HOME: "/tmp/pi-ez-web-test-home", ...overrides });
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("public Git URL validation rejects credentials and non-HTTPS schemes", () => {
  assert.equal(parsePublicGitUrl("https://example.test/a/repo.git?download=1"), "https://example.test/a/repo.git");
  assert.throws(() => parsePublicGitUrl("http://example.test/a/repo.git"), error => error.code === "invalid_git_url");
  assert.throws(() => parsePublicGitUrl("ssh://git@example.test/a/repo.git"), error => error.code === "invalid_git_url");
  assert.throws(() => parsePublicGitUrl("https://user:password@example.test/a/repo.git"), error => error.code === "invalid_git_url");
});

test("GitHub clone uses the protocol helper, not URL or argv", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-"));
  let call;
  try {
    const result = await withSyntheticEnvironment({ HOME: path.join(tmp, "home"), PI_WEB_HOME: path.join(tmp, "pi-web") }, () => cloneRepository({
      source: "github",
      fullName: "bry-guy/private-repo",
      github: fakeGithub(),
      root: tmp,
      runGit: async (_file, args, options) => {
        call = { args, options };
        const destination = args.at(-1);
        fs.writeFileSync(path.join(destination, "README.md"), "cloned\n");
      },
    }));
    assert.equal(result.repoPath, path.join(tmp, "private-repo"));
    assert.equal(fs.readFileSync(path.join(result.repoPath, "README.md"), "utf8"), "cloned\n");
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(call.options.env.GIT_ASKPASS, undefined);
    assert.equal(call.options.env.PI_WEB_GIT_TOKEN, undefined);
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, os.devNull);
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(call.options.env.GIT_CONFIG_COUNT, "2");
    assert.equal(call.options.env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
    assert.equal(call.options.env.GIT_CONFIG_VALUE_0, "");
    assert.equal(call.options.env.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
    const credentials = spawnSync("git", ["credential", "fill"], {
      cwd: tmp,
      env: call.options.env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    assert.equal(credentials.status, 0, credentials.stderr);
    assert.match(credentials.stdout, /username=x-access-token/);
    assert.match(credentials.stdout, /password=gho_secret-token/);
    assert.doesNotMatch(call.args.join(" "), /gho_secret-token/);
    assert.doesNotMatch(call.args.join(" "), /user:password/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("public GitHub repositories clone without an OAuth token", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-public-"));
  const marker = path.join(tmp, "conflicting-helper-called");
  const conflictingHelper = path.join(tmp, "conflicting-helper");
  fs.writeFileSync(conflictingHelper, `#!/bin/sh\ntouch ${marker}\nprintf 'protocol=https\\nhost=github.com\\nusername=conflict\\npassword=conflict\\n\\n'\n`);
  fs.chmodSync(conflictingHelper, 0o700);
  let call;
  try {
    const result = await withSyntheticEnvironment({
      HOME: path.join(tmp, "home"),
      PI_WEB_HOME: path.join(tmp, "pi-web"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: conflictingHelper,
    }, () => cloneRepository({
      source: "github",
      fullName: "bry-guy/private-repo",
      github: fakeGithub({ token: null }),
      root: tmp,
      runGit: async (_file, args, options) => {
        call = { args, options };
        fs.writeFileSync(path.join(args.at(-1), "README.md"), "public\n");
      },
    }));
    assert.equal(result.source.fullName, "bry-guy/private-repo");
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(call.options.env.GIT_ASKPASS, undefined);
    assert.equal(call.options.env.PI_WEB_GIT_TOKEN, undefined);
    assert.equal(call.options.env.PI_WEB_GITHUB_TOKEN, undefined);
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, os.devNull);
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(call.options.env.GIT_CONFIG_COUNT, "1");
    const credentials = spawnSync("git", [...call.args.slice(0, 2), "credential", "fill"], {
      cwd: tmp,
      env: call.options.env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    assert.notEqual(credentials.status, 0);
    assert.equal(credentials.stdout, "");
    assert.doesNotMatch(credentials.stderr, /conflict|stored-token/);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(call.args.slice(0, 3), ["-c", "credential.helper=", "clone"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("public URL clones do not use stored OAuth credentials", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-public-url-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-public-home-"));
  let call;
  try {
    fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "stored-token" }));
    await withSyntheticEnvironment({ HOME: path.join(tmp, "home"), PI_WEB_HOME: home }, async () => {
      await cloneRepository({
        source: "git-url",
        url: "https://github.com/bry-guy/public-repo.git",
        root: tmp,
        runGit: async (_file, args, options) => {
          call = { args, options };
          fs.writeFileSync(path.join(args.at(-1), "README.md"), "public\n");
        },
      });
    });
    const credentials = spawnSync("git", ["credential", "fill"], {
      cwd: tmp,
      env: call.options.env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    assert.notEqual(credentials.status, 0);
    assert.equal(credentials.stdout, "");
    assert.doesNotMatch(credentials.stderr, /stored-token/);
    assert.equal(call.options.env.GIT_ASKPASS, undefined);
    assert.deepEqual(call.args.slice(0, 3), ["-c", "credential.helper=", "clone"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("private GitHub repositories require OAuth before cloning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-private-"));
  try {
    await assert.rejects(() => cloneRepository({
      source: "github",
      fullName: "bry-guy/private-repo",
      github: fakeGithub({ token: null, privateRepo: true }),
      root: tmp,
    }), error => error.code === "github_auth_required");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("clone setup failures remove temporary directories and release the destination lock", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-clone-config-fail-"));
  let runGitCalled = false;
  try {
    await withSyntheticEnvironment({ HOME: path.join(tmp, "home"), PI_WEB_HOME: path.join(tmp, "pi-web"), GIT_CONFIG_COUNT: "invalid" }, async () => {
      await assert.rejects(() => cloneRepository({
        source: "github",
        fullName: "bry-guy/private-repo",
        github: fakeGithub(),
        root: tmp,
        runGit: async () => { runGitCalled = true; throw new Error("git must not run"); },
      }), error => error.code === "clone_failed");
    });
    assert.equal(runGitCalled, false);
    assert.deepEqual(fs.readdirSync(tmp), []);
    let result;
    await withSyntheticEnvironment({ HOME: path.join(tmp, "retry-home"), PI_WEB_HOME: path.join(tmp, "retry-pi-web") }, async () => {
      result = await cloneRepository({
        source: "github",
        fullName: "bry-guy/private-repo",
        github: fakeGithub(),
        root: tmp,
        runGit: async (_file, args) => {
          fs.writeFileSync(path.join(args.at(-1), "README.md"), "retry\n");
        },
      });
    });
    assert.equal(fs.readFileSync(path.join(result.repoPath, "README.md"), "utf8"), "retry\n");
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
