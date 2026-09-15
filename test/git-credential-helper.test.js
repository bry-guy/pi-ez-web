import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { gitCredentialEnvironment } from "../server/git-credentials.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "server", "git-credential-helper.js");

function runHelper(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("Git credentials prefer the runtime token over stored OAuth", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "stored-token" }));
    const result = await runHelper([], "protocol=https\nhost=github.com\n\n", {
      ...process.env,
      PI_WEB_HOME: home,
      PI_WEB_GITHUB_TOKEN: "environment-token",
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /password=environment-token/);
    assert.doesNotMatch(result.stdout, /stored-token/);
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Git credentials fall back to stored OAuth and reject other hosts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "stored-token" }));
    const stored = await runHelper([], "protocol=https\nhost=github.com\n\n", { ...process.env, PI_WEB_HOME: home });
    assert.equal(stored.code, 0);
    assert.match(stored.stdout, /password=stored-token/);
    const other = await runHelper([], "protocol=https\nhost=example.test\n\n", { ...process.env, PI_WEB_HOME: home });
    assert.equal(other.code, 0);
    assert.equal(other.stdout, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Git askpass uses the same environment-first credential", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "stored-token" }));
    const result = await runHelper(["Password for 'https://github.com/example/repo':"], "", {
      ...process.env,
      PI_WEB_HOME: home,
      PI_WEB_GITHUB_TOKEN: "environment-token",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "environment-token\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("network Git environments use a child-scoped askpass helper", () => {
  const source = { PATH: "/bin", PI_WEB_GITHUB_TOKEN: "environment-token" };
  const result = gitCredentialEnvironment(source);
  assert.equal(result.PATH, source.PATH);
  assert.equal(result.PI_WEB_GITHUB_TOKEN, source.PI_WEB_GITHUB_TOKEN);
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GIT_ASKPASS, pathToFileURL(helper).pathname);
  assert.equal(result.GIT_ASKPASS_REQUIRE, "force");
  assert.equal(source.GIT_ASKPASS, undefined);
});
