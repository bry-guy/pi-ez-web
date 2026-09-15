import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";

function isolatedEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/tmp/pi-ez-web-test-home",
    ...overrides,
  };
}

async function withEnvironment(environment, callback) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("network Git operations use protocol credentials without changing Git semantics", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-operation-"));
  const repo = path.join(tmp, "repo");
  const remote = path.join(tmp, "remote.git");
  const bin = path.join(tmp, "bin");
  const trace = path.join(tmp, "trace");
  const credentials = path.join(tmp, "credentials");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const fixtureEnvironment = isolatedEnvironment({
    HOME: path.join(tmp, "fixture-home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const setupGit = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: "utf8", env: fixtureEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nset -eu\ncase \"$1\" in\n  fetch|pull|push)\n    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"${GIT_TERMINAL_PROMPT-}\" \"${GIT_ASKPASS+x}\" \"${GIT_CONFIG_COUNT-}\" \"${GIT_CONFIG_KEY_0-}\" \"${GIT_CONFIG_VALUE_0-}\" \"${GIT_CONFIG_KEY_1-}\" \"$*\" >> \"$PI_TEST_GIT_TRACE\"\n    printf 'protocol=https\\nhost=github.com\\n\\n' | \"$PI_TEST_GIT_REAL\" credential fill >> \"$PI_TEST_GIT_CREDENTIALS\"\n    ;;\nesac\nexec \"$PI_TEST_GIT_REAL\" \"$@\"\n");
  fs.chmodSync(path.join(bin, "git"), 0o700);
  setupGit(tmp, "init", "--bare", remote);
  fs.mkdirSync(repo);
  setupGit(repo, "init", "-b", "main");
  setupGit(repo, "config", "user.email", "test@example.com");
  setupGit(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  setupGit(repo, "add", "README.md");
  setupGit(repo, "commit", "-m", "initial");
  setupGit(repo, "remote", "add", "origin", remote);
  setupGit(repo, "push", "-u", "origin", "main");
  setupGit(repo, "switch", "-c", "feature");
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  setupGit(repo, "add", "feature.txt");
  setupGit(repo, "commit", "-m", "feature");
  setupGit(repo, "push", "-u", "origin", "feature");
  setupGit(repo, "switch", "main");

  const environment = isolatedEnvironment({
    PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`,
    HOME: path.join(tmp, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PI_TEST_GIT_TRACE: trace,
    PI_TEST_GIT_CREDENTIALS: credentials,
    PI_TEST_GIT_REAL: realGit,
    PI_WEB_GITHUB_TOKEN: "environment-token",
    GIT_ASKPASS: "/tmp/inherited-askpass",
    GIT_ASKPASS_REQUIRE: "force",
  });
  const events = [];
  try {
    await withEnvironment(environment, async () => {
      ws.prepareMain(repo, { report: event => events.push(event) });
      await ws.prepareMainAsync(repo, { report: event => events.push(event) });
      await ws.fetchRepositoryAsync(repo, { report: event => events.push(event) });
      ws.pullWorkspace(repo);
      git(repo, "switch", "feature");
      ws.pushWorkspace(repo, { report: event => events.push(event) });
    });

    const records = fs.readFileSync(trace, "utf8").trim().split(/\r?\n/).map(line => line.split("\t"));
    assert.deepEqual(records.map(record => record[0]), ["fetch", "fetch", "fetch", "pull", "push"]);
    for (const record of records) {
      assert.equal(record[1], "0");
      assert.equal(record[2], "");
      assert.equal(record[3], "2");
      assert.equal(record[4], "credential.https://github.com.helper");
      assert.equal(record[5], "");
      assert.equal(record[6], "credential.https://github.com.helper");
    }
    assert.deepEqual(records.map(record => record[7]), [
      "fetch --prune origin",
      "fetch --prune origin",
      "fetch --all --prune",
      "pull --ff-only",
      "push",
    ]);
    assert.doesNotMatch(JSON.stringify(records), /environment-token/);
    const credentialOutput = fs.readFileSync(credentials, "utf8");
    assert.equal((credentialOutput.match(/password=environment-token/g) || []).length, records.length);
    assert.doesNotMatch(JSON.stringify(events), /environment-token/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
