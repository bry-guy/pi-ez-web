import { store } from "./store.js";

function id() {
  try { return globalThis.crypto?.randomUUID?.() || `op_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
  catch { return `op_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function event(type, message, extra = {}) {
  return { at: Date.now(), elapsedMs: 0, type, message: String(message || ""), ...extra };
}

export function beginOperation(kind, title, command = "", initialMessage = "") {
  const startedAt = Date.now();
  const operation = {
    id: id(), kind, title, command: command || "", status: "running", stdout: "", stderr: "", exit: null,
    httpStatus: null, startedAt, events: [], lastUpdatedAt: startedAt,
  };
  if (initialMessage) operation.events.push(event("client", initialMessage));
  store.set({ operation });
  return operation;
}

export function appendOperationEvent(operationId, incoming) {
  const operation = store.state.operation;
  if (!operation || operation.id !== operationId || !incoming) return;
  const next = { ...incoming, at: Number(incoming.at) || Date.now() };
  operation.events ||= [];
  operation.events.push(next);
  if (operation.events.length > 600) operation.events.splice(0, operation.events.length - 600);
  operation.lastUpdatedAt = next.at;
  store.notify("state");
}

function mergeResultEvents(operation, result) {
  const events = result?.operation?.events;
  if (!Array.isArray(events)) return;
  operation.events = events.slice(-600);
  operation.lastUpdatedAt = operation.events.at(-1)?.at || Date.now();
}

export function completeOperation(operation, result = {}, error = null) {
  const failed = !!error || result.ok === false || result.operation?.status === "error";
  const stderr = result.stderr || (error ? error.detail || error.message || String(error) : "");
  const next = {
    ...operation,
    status: failed ? "error" : "success",
    command: result.command || operation.command,
    stdout: result.stdout || operation.stdout || "",
    stderr,
    exit: Number.isFinite(result.exit) ? result.exit : null,
    httpStatus: Number.isFinite(result.httpStatus) ? result.httpStatus : result.operation?.httpStatus || error?.operation?.httpStatus || null,
    finishedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
  mergeResultEvents(next, result);
  if (error?.operation?.events) {
    next.events = error.operation.events.slice(-600);
    next.lastUpdatedAt = next.events.at(-1)?.at || next.lastUpdatedAt;
  }
  if (error && !next.events.some(item => item.type === "error" && item.message === stderr)) {
    next.events.push(event("error", stderr));
  }
  store.set({ operation: next });
}

export function completeOperationSnapshot(snapshot) {
  const operation = store.state.operation;
  if (!operation || !snapshot || operation.id !== snapshot.id) return;
  const result = { operation: snapshot, ok: snapshot.status !== "error", exit: snapshot.exit, httpStatus: snapshot.httpStatus };
  completeOperation(operation, result);
}

export function showCompletedOperation(kind, title, result, command = "") {
  const operation = beginOperation(kind, title, command, "Result received.");
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
    operation: values.map(result => result.operation).filter(Boolean).at(-1),
  };
}
