import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hookEnvironment, runHook } from "../server/hooks.js";
import { redact } from "../server/redaction.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("hook environments keep functional paths and drop inherited secrets", () => {
  const env = hookEnvironment({
    PATH: "/bin",
    HOME: "/home/node",
    PI_WEB_HOME: "/data/pi-ez-web",
    PI_CODING_AGENT_DIR: "/data/pi-ez-agent",
    OP_SERVICE_ACCOUNT_TOKEN: "private",
    PI_WEB_GITHUB_TOKEN: "private",
    HOOK_PRIVATE: "private",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/node",
    PI_WEB_HOME: "/data/pi-ez-web",
    PI_CODING_AGENT_DIR: "/data/pi-ez-agent",
  });
});

test("hook timeout terminates the child process group", async () => {
  const started = Date.now();
  const result = await runHook("sleep 5", { timeoutMs: 25 });
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /Hook timed out/);
  assert.ok(Date.now() - started < 1000);
});

test("hook timeout kills SIGTERM-ignoring descendants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-hook-"));
  const marker = path.join(root, "delayed-marker");
  const quoted = `'${marker.replaceAll("'", "'\\''")}'`;
  try {
    const started = Date.now();
    const result = await runHook(`(trap '' TERM; sleep 1; printf delayed > ${quoted}) & wait`, { timeoutMs: 25 });
    assert.equal(result.exit, 1);
    assert.ok(Date.now() - started < 900);
    await wait(1200);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook cancellation terminates the child process group", async () => {
  const controller = new AbortController();
  const resultPromise = runHook("sleep 5", { signal: controller.signal, timeoutMs: 5000 });
  await wait(20);
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /Hook cancelled/);
});

test("hook output is capped", async () => {
  const result = await runHook("printf 12345678901234567890", { maxOutputBytes: 8 });
  assert.equal(result.exit, 1);
  assert.ok(Buffer.byteLength(result.stdout) <= 8);
  assert.match(result.stderr, /Hook output exceeded its limit/);
});

test("shared redaction removes configured and patterned secrets", () => {
  const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "operator-secret";
  try {
    assert.equal(redact("operator-secret ops_private-token Bearer abc ghp_token sk-secret"), "[redacted] [redacted] Bearer [redacted] [redacted] sk-[redacted]");
  } finally {
    if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
  }
});
