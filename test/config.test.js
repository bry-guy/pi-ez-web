import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appHome, loadBindings, projectMode, saveBindings, worktreeRoot } from "../server/config.js";

let tmp;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-config-"));
  process.env.PI_WEB_HOME = tmp;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("worktree root defaults beside Pi and respects an explicit override", () => {
  assert.equal(worktreeRoot({}), path.join(os.homedir(), ".pi", "worktrees"));
  assert.equal(worktreeRoot({ worktreeRoot: "/x" }), "/x");
});

test("project modes default to manual and preserve only valid values", () => {
  assert.equal(projectMode({}), "manual");
  assert.equal(projectMode({ mode: "auto" }), "auto");
  assert.equal(projectMode({ mode: "invalid" }), "manual");
});

test("bindings v1 strings migrate to v2 objects and round-trip", () => {
  fs.mkdirSync(appHome(), { recursive: true });
  const file = path.join(appHome(), "bindings.json");
  fs.writeFileSync(file, JSON.stringify({ s1: "/tmp/old-worktree" }));
  assert.deepEqual(loadBindings(), { s1: { branch: null, workspacePath: "/tmp/old-worktree" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { s1: { branch: null, workspacePath: "/tmp/old-worktree" } });

  saveBindings({ s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
  assert.deepEqual(loadBindings(), { s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
});
