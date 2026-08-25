import { store } from "./store.js";

function id() {
  try { return globalThis.crypto?.randomUUID?.() || `op_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
  catch { return `op_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function event(type, message, extra = {}) {
  return { at: Date.now(), elapsedMs: 0, type, message: String(message || ""), ...extra };
}

function operationTime(operation) {
  return Number(operation.lastUpdatedAt || operation.finishedAt || operation.startedAt || 0);
}

function remember(operation) {
  const history = [...(store.state.operations || []).filter(item => item.id !== operation.id), operation]
    .sort((a, b) => (operationTime(b) - operationTime(a)) || (b.id === operation.id ? 1 : a.id === operation.id ? -1 : 0));
  store.set({ operation: history[0] || null, operations: history.slice(0, 100) });
}

function scopeValues(value) {
  return value && typeof value === "object" ? value : {};
}

function matchesScope(operation, scope) {
  const values = scopeValues(scope);
  const scoped = ["sessionId", "projectId", "contextId", "workspacePath"];
  if (!scoped.some(key => operation[key] != null && operation[key] !== "")) return !Object.keys(values).length;
  if (values.sessionId != null && operation.sessionId != null) return operation.sessionId === values.sessionId;
  if (values.sessionId != null && operation.projectId != null) return operation.projectId === values.projectId;
  if (values.projectId != null && operation.projectId != null) return operation.projectId === values.projectId;
  if (values.contextId != null && operation.contextId != null) return operation.contextId === values.contextId;
  if (values.workspacePath != null && operation.workspacePath != null) return operation.workspacePath === values.workspacePath;
  return false;
}

export function operationsFor(kinds = null, scope = null) {
  const allowed = kinds == null ? null : new Set(Array.isArray(kinds) ? kinds : [kinds]);
  return (store.state.operations || [])
    .filter(operation => (!allowed || allowed.has(operation.kind)) && matchesScope(operation, scope))
    .sort((a, b) => operationTime(b) - operationTime(a));
}

export function operationFor(kinds, scope = null) {
  return operationsFor(kinds, scope)[0] || null;
}

export function operationForScope(kinds, scope = {}) {
  return operationFor(kinds, scope);
}

export function activeOperations(scope = {}) {
  return operationsFor(null, scope).filter(operation => operation.status === "running");
}

export function operationFeed(scope = {}, kinds = null) {
  return operationsFor(kinds, scope)
    .flatMap(operation => (operation.events || []).map(eventValue => ({ ...eventValue, operation, operationId: operation.id })))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

export function operationHint(operation, fallback = "Working…") {
  if (!operation) return "";
  const last = operation.events?.at(-1);
  const eventValue = last?.message || last?.output || "";
  const generic = new Set(["Request started.", "Result received."]);
  const candidate = generic.has(eventValue)
    ? operation.status === "error" ? operation.stderr : operation.status === "success" ? operation.stdout : fallback
    : eventValue || (operation.status === "error" ? operation.stderr : "") || (operation.status === "success" ? operation.stdout : "") || fallback;
  return String(candidate).replace(/\s+/g, " ").trim().slice(0, 220) || fallback;
}

export function beginOperation(kind, title, command = "", initialMessage = "", sessionId = null, scope = {}) {
  if (sessionId && typeof sessionId === "object") {
    scope = sessionId;
    sessionId = scope.sessionId || null;
  }
  const metadata = scopeValues(scope);
  const startedAt = Date.now();
  const operation = {
    id: id(), kind, title, sessionId: sessionId || metadata.sessionId || null,
    projectId: metadata.projectId || null, contextId: metadata.contextId || null,
    workspacePath: metadata.workspacePath || null, action: metadata.action || null,
    command: command || "", status: "running", stdout: "", stderr: "", exit: null,
    httpStatus: null, startedAt, events: [], lastUpdatedAt: startedAt,
  };
  if (initialMessage) operation.events.push(event("client", initialMessage));
  remember(operation);
  return operation;
}

export function appendOperationEvent(operationId, incoming) {
  const operation = (store.state.operations || []).find(item => item.id === operationId);
  if (!operation || !incoming) return;
  const nextEvent = { ...incoming, at: Number(incoming.at) || Date.now() };
  operation.events = [...(operation.events || []), nextEvent].slice(-600);
  operation.lastUpdatedAt = Math.max(operationTime(operation), nextEvent.at);
  remember(operation);
}

function mergeResultEvents(operation, result) {
  const events = result?.operation?.events;
  if (!Array.isArray(events)) return;
  operation.events = events.slice(-600);
  operation.lastUpdatedAt = Math.max(operation.lastUpdatedAt || 0, operation.events.at(-1)?.at || 0, Date.now());
}

export function completeOperation(operation, result = {}, error = null) {
  const current = (store.state.operations || []).find(item => item.id === operation?.id) || operation;
  if (!current) return;
  const failed = !!error || result.ok === false || result.operation?.status === "error";
  const stderr = result.stderr || (error ? error.detail || error.message || String(error) : "");
  const finishedAt = Date.now();
  const next = {
    ...current,
    status: failed ? "error" : "success",
    command: result.command || current.command,
    stdout: result.stdout || current.stdout || "",
    stderr,
    exit: Number.isFinite(result.exit) ? result.exit : null,
    httpStatus: Number.isFinite(result.httpStatus) ? result.httpStatus : result.operation?.httpStatus || error?.operation?.httpStatus || error?.status || null,
    finishedAt,
    lastUpdatedAt: finishedAt,
  };
  mergeResultEvents(next, result);
  if (error?.operation?.events) {
    next.events = error.operation.events.slice(-600);
    next.lastUpdatedAt = next.events.at(-1)?.at || next.lastUpdatedAt;
  }
  if (error && !next.events.some(item => item.type === "error" && item.message === stderr)) {
    next.events.push(event("error", stderr));
  }
  next.events = next.events.slice(-600);
  remember(next);
}

export function completeOperationSnapshot(snapshot) {
  const operation = (store.state.operations || []).find(item => item.id === snapshot?.id);
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
