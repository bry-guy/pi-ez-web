import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveBindings, saveClosed } from "../server/config.js";
import { readLogs } from "../server/logging.js";
import { RealSupervisor } from "../server/supervisor/real.js";

function createScenario(operationError) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-visibility-recovery-"));
  const previousHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = path.join(tmp, "web");
  fs.mkdirSync(process.env.PI_WEB_HOME, { recursive: true });
  const sourceId = "source-session";
  const targetId = "target-session";
  const sourceFile = path.join(tmp, `${sourceId}.jsonl`);
  const targetFile = path.join(tmp, `${targetId}.jsonl`);
  const oldTargetFile = path.join(tmp, "old-target.jsonl");
  const sourceBinding = { projectId: "project-1", workspacePath: path.join(tmp, "workspace-source") };
  const sourceInfo = { id: sourceId, path: sourceFile, cwd: sourceBinding.workspacePath, model: "test/model" };
  const targetInfo = { id: targetId, path: oldTargetFile, cwd: path.join(tmp, "workspace-target"), model: "test/old-model" };
  const sourceSession = {
    sessionId: sourceId,
    sessionFile: sourceFile,
    sessionManager: { getBranch: () => [] },
    model: { provider: "test", id: "model", api: "test" },
    isStreaming: false,
    extensionRunner: { emit: async () => undefined },
    subscribe: () => () => {},
    dispose() {},
  };
  const current = { cwd: sourceBinding.workspacePath, session: sourceSession };
  const targetManager = {
    getSessionFile: () => targetFile,
    getSessionId: () => targetId,
    getCwd: () => path.join(tmp, "workspace-target"),
    getBranch: () => [],
  };
  const supervisor = new RealSupervisor({ emit: () => { throw operationError; } });
  supervisor.live.set(sourceId, current);
  supervisor.paths.set(sourceId, sourceFile);
  supervisor.paths.set(targetId, oldTargetFile);
  supervisor.preferredPaths.set(sourceId, sourceFile);
  supervisor.preferredPaths.set(targetId, oldTargetFile);
  supervisor.info.set(sourceId, sourceInfo);
  supervisor.info.set(targetId, targetInfo);
  supervisor._modelRuntime = async () => ({});
  supervisor._disposeLiveState = async () => {};
  supervisor._createConfiguredSession = async ({ sessionManager }) => ({
    session: {
      sessionId: targetId,
      sessionFile: targetFile,
      sessionManager,
      model: { provider: "test", id: "model", api: "test" },
      isStreaming: false,
      extensionRunner: { emit: async () => undefined },
      subscribe: () => () => {},
      dispose() {},
    },
  });
  supervisor._boundCwd = () => sourceBinding.workspacePath;
  supervisor._preferredModel = async () => "test/model";
  const attachCalls = [];
  supervisor._attach = async (id, cwd, model) => {
    attachCalls.push({ id, cwd, model });
    supervisor.live.set(id, current);
    return current;
  };
  saveBindings({
    [sourceId]: sourceBinding,
    [targetId]: { projectId: "project-1", workspacePath: path.join(tmp, "workspace-target") },
  });
  saveClosed(new Set([targetId]));

  return {
    tmp,
    sourceId,
    targetId,
    sourceFile,
    oldTargetFile,
    sourceInfo,
    targetInfo,
    sourceBinding,
    current,
    targetManager,
    supervisor,
    attachCalls,
    run: () => supervisor._replaceLiveSession(sourceId, current, targetManager, { reason: "resume" }),
    cleanup() {
      if (previousHome === undefined) delete process.env.PI_WEB_HOME;
      else process.env.PI_WEB_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function withRenameFailures(failure, run) {
  const originalRename = fs.renameSync;
  const writes = new Map();
  fs.renameSync = (from, to, ...args) => {
    const name = path.basename(to);
    const count = (writes.get(name) || 0) + 1;
    writes.set(name, count);
    const error = failure(name, count);
    if (error) throw error;
    return originalRename.call(fs, from, to, ...args);
  };
  try { return await run(writes); } finally { fs.renameSync = originalRename; }
}

function assertRestored(scenario) {
  const { sourceId, targetId, sourceFile, oldTargetFile, sourceInfo, targetInfo, sourceBinding, current, supervisor, attachCalls } = scenario;
  assert.equal(supervisor.live.get(sourceId), current);
  assert.equal(supervisor.live.has(targetId), false);
  assert.equal(supervisor.paths.get(sourceId), sourceFile);
  assert.equal(supervisor.paths.get(targetId), oldTargetFile);
  assert.equal(supervisor.preferredPaths.get(sourceId), sourceFile);
  assert.equal(supervisor.preferredPaths.get(targetId), oldTargetFile);
  assert.deepEqual(supervisor.info.get(sourceId), sourceInfo);
  assert.deepEqual(supervisor.info.get(targetId), targetInfo);
  assert.deepEqual(attachCalls, [{ id: sourceId, cwd: sourceBinding.workspacePath, model: "test/model" }]);
}

function assertRecoveryLog(sourceId, failureCount = 2) {
  const entry = readLogs().find(log => log.message === "session_visibility_recovery_failed");
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "failureCount", "level", "message", "sourceSessionId"]);
  assert.equal(entry.level, "error");
  assert.equal(entry.sourceSessionId, sourceId);
  assert.equal(entry.failureCount, failureCount);
  assert.doesNotMatch(JSON.stringify(entry), /private-path-canary|credential-canary|operation-canary/);
}

test("explicit visibility rollback failures are attached, logged, and do not stop in-memory restoration", async () => {
  const cause = new Error("operation-canary cause");
  const operationError = Object.assign(new Error("hub operation failed"), { code: "hub_emit_failed", cause });
  const knownError = new Error("known rollback /private-path-canary credential-canary");
  Object.defineProperty(operationError, "rollbackErrors", { value: [knownError], configurable: true });
  const scenario = createScenario(operationError);
  const bindingsError = new Error("restore /private-path-canary credential-canary");
  const closedError = new Error("restore /private-path-canary credential-canary");

  try {
    await withRenameFailures((name, count) => {
      if (count === 2 && name === "bindings.json") return bindingsError;
      if (count === 2 && name === "closed.json") return closedError;
    }, async writes => {
      await assert.rejects(scenario.run(), error => {
        assert.equal(error, operationError);
        assert.equal(error.code, "hub_emit_failed");
        assert.equal(error.cause, cause);
        assert.deepEqual(error.rollbackErrors, [knownError, bindingsError, closedError]);
        return true;
      });
      assert.equal(writes.get("bindings.json"), 2);
      assert.equal(writes.get("closed.json"), 2);
    });
    assertRestored(scenario);
    assertRecoveryLog(scenario.sourceId, 3);
  } finally { scenario.cleanup(); }
});

test("commit rollbackErrors are logged without replacing the original operation error", async () => {
  const cause = new Error("operation-canary cause");
  const operationError = Object.assign(new Error("commit /private-path-canary credential-canary"), { code: "commit_failed", cause });
  const scenario = createScenario(operationError);
  const bindingsError = new Error("restore /private-path-canary credential-canary");
  const closedError = new Error("restore /private-path-canary credential-canary");

  try {
    await withRenameFailures((name, count) => {
      if (count === 1 && name === "closed.json") return operationError;
      if (count === 2 && name === "bindings.json") return bindingsError;
      if (count === 2 && name === "closed.json") return closedError;
    }, async writes => {
      await assert.rejects(scenario.run(), error => {
        assert.equal(error, operationError);
        assert.equal(error.code, "commit_failed");
        assert.equal(error.cause, cause);
        assert.deepEqual(error.rollbackErrors, [bindingsError, closedError]);
        assert.equal(Object.getOwnPropertyDescriptor(error, "rollbackErrors").writable, false);
        return true;
      });
      assert.equal(writes.get("bindings.json"), 2);
      assert.equal(writes.get("closed.json"), 2);
    });
    assertRestored(scenario);
    assertRecoveryLog(scenario.sourceId);
  } finally { scenario.cleanup(); }
});
