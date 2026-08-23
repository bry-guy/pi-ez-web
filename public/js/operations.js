import { store } from "./store.js";

export function beginOperation(kind, title, command = "", stdout = "") {
  const operation = { kind, title, command, status: "running", stdout, stderr: "", exit: null, startedAt: Date.now() };
  store.set({ operation });
  return operation;
}

export function completeOperation(operation, result = {}, error = null) {
  const failed = !!error || result.ok === false;
  const stderr = result.stderr || (error ? error.detail || error.message || String(error) : "");
  store.set({ operation: {
    ...operation,
    status: failed ? "error" : "success",
    command: result.command || operation.command,
    stdout: result.stdout || operation.stdout || "",
    stderr,
    exit: Number.isFinite(result.exit) ? result.exit : failed ? 1 : 0,
    finishedAt: Date.now(),
  } });
}

export function showCompletedOperation(kind, title, result, command = "") {
  const operation = { kind, title, command, status: "running", stdout: "", stderr: "", exit: null, startedAt: Date.now() };
  completeOperation(operation, result);
}

export function combineOperationResults(...results) {
  const values = results.filter(Boolean);
  return {
    ok: values.every(result => result.ok !== false),
    command: values.map(result => result.command).filter(Boolean).join("\n"),
    stdout: values.map(result => result.stdout).filter(Boolean).join("\n"),
    stderr: values.map(result => result.stderr).filter(Boolean).join("\n"),
    exit: values.at(-1)?.exit,
  };
}
