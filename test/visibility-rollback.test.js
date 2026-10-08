import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appHome, loadBindings, loadClosed, prepareSessionVisibilityReplacement, saveBindings, saveClosed } from "../server/config.js";

let tmp;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-visibility-rollback-"));
  process.env.PI_WEB_HOME = tmp;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function withRenames(handler, run) {
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => handler(to, () => originalRename.call(fs, from, to, ...args));
  try { run(); } finally { fs.renameSync = originalRename; }
}

function setState() {
  const bindings = { source: { projectId: "p1", workspacePath: "/tmp/project" } };
  const closed = new Set(["target"]);
  saveBindings(bindings);
  saveClosed(closed);
  return { bindings, closed };
}

const prepare = () => prepareSessionVisibilityReplacement("source", "target", "/tmp/project");

test("commit preserves the forward error when both restorations succeed", () => {
  const before = setState();
  const closedFile = path.join(appHome(), "closed.json");
  const forwardError = Object.assign(new Error("forward write failed"), { code: "EIO" });
  let closedWrites = 0;

  withRenames((to, rename) => {
    if (to === closedFile && ++closedWrites === 1) throw forwardError;
    return rename();
  }, () => assert.throws(() => prepare().commit(), error => {
    assert.equal(error, forwardError);
    assert.equal(error.code, "EIO");
    assert.equal(error.rollbackErrors, undefined);
    return true;
  }));

  assert.deepEqual(loadBindings(), before.bindings);
  assert.deepEqual(loadClosed(), before.closed);
});

test("commit reports both restore failures and attempts both writes", () => {
  setState();
  const bindingsFile = path.join(appHome(), "bindings.json");
  const closedFile = path.join(appHome(), "closed.json");
  const forwardError = Object.assign(new Error("forward write failed"), { code: "EIO" });
  const bindingsError = new Error("bindings restore failed");
  const closedError = new Error("closed restore failed");
  let bindingsWrites = 0;
  let closedWrites = 0;

  withRenames((to, rename) => {
    if (to === bindingsFile && ++bindingsWrites === 2) throw bindingsError;
    if (to === closedFile) {
      closedWrites++;
      if (closedWrites === 1) throw forwardError;
      if (closedWrites === 2) throw closedError;
    }
    return rename();
  }, () => assert.throws(() => prepare().commit(), error => {
    assert.equal(error, forwardError);
    assert.equal(error.code, "EIO");
    assert.deepEqual(error.rollbackErrors, [bindingsError, closedError]);
    return true;
  }));

  assert.equal(bindingsWrites, 2);
  assert.equal(closedWrites, 2);
});

test("explicit rollback reports both restore failures", () => {
  setState();
  const bindingsFile = path.join(appHome(), "bindings.json");
  const closedFile = path.join(appHome(), "closed.json");
  const bindingsError = new Error("bindings restore failed");
  const closedError = new Error("closed restore failed");
  let bindingsWrites = 0;
  let closedWrites = 0;
  const committed = prepare().commit();

  withRenames((to, rename) => {
    if (to === bindingsFile) {
      bindingsWrites++;
      throw bindingsError;
    }
    if (to === closedFile) {
      closedWrites++;
      throw closedError;
    }
    return rename();
  }, () => assert.throws(() => committed.rollback(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [bindingsError, closedError]);
    return true;
  }));

  assert.equal(bindingsWrites, 1);
  assert.equal(closedWrites, 1);
});

test("successful explicit rollback restores the original state", () => {
  const before = setState();
  prepare().commit().rollback();
  assert.deepEqual(loadBindings(), before.bindings);
  assert.deepEqual(loadClosed(), before.closed);
});
