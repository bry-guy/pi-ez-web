import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-home-"));
process.env.PI_WEB_HOME = home;
const { appendHistory, readHistory } = await import("../server/workspace-history.js");
const { createOperationReporter } = await import("../server/operations.js");

test("workspace history is append-only, newest first, and per workspace", () => {
  const a = "/work/a";
  const b = "/work/b";
  appendHistory(a, { kind: "hook", title: "Setup hook", status: "success", output: "installed\n" });
  appendHistory(a, { kind: "push", title: "Push branch", status: "error", output: "rejected" });
  appendHistory(b, { kind: "pull", title: "Pull branch", status: "success", output: "" });
  const entries = readHistory(a);
  assert.deepEqual(entries.map(entry => entry.kind), ["push", "hook"]);
  assert.equal(readHistory(b).length, 1);
  assert.deepEqual(readHistory("/work/none"), []);
});

test("a torn final line is skipped and output is capped", () => {
  const ws = "/work/torn";
  appendHistory(ws, { kind: "hook", title: "Setup hook", status: "success", output: "x".repeat(40_000) });
  const file = fs.readdirSync(path.join(home, "workspace-history")).map(name => path.join(home, "workspace-history", name)).find(name => fs.readFileSync(name, "utf8").includes("Setup hook"));
  fs.appendFileSync(file, "{\"kind\":");
  const [entry] = readHistory(ws);
  assert.equal(entry.kind, "hook");
  assert.ok(entry.output.length <= 16_000);
});

test("a bound operation is recorded with its output when it finishes", () => {
  const ws = "/work/bound";
  const reporter = createOperationReporter({ kind: "hook", title: "Setup hook" });
  reporter.bind(ws);
  reporter.log({ type: "output", stream: "stdout", output: "npm ci done" });
  reporter.finish({ status: "error", httpStatus: 422, exit: 1, message: "Configured hook failed." });
  const [entry] = readHistory(ws);
  assert.equal(entry.status, "error");
  assert.equal(entry.exit, 1);
  assert.match(entry.output, /npm ci done/);
  const unbound = createOperationReporter({ kind: "fetch", title: "Fetch" });
  unbound.finish({ status: "success" });
  assert.equal(readHistory(ws).length, 1, "unbound operations are not recorded");
});
