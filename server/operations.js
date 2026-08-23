import { randomUUID } from "node:crypto";
import { hub } from "./events.js";

const MAX_EVENTS = 600;
const MAX_TEXT = 12_000;

function text(value, max = MAX_TEXT) {
  let result = String(value ?? "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
  for (const secret of [process.env.OP_SERVICE_ACCOUNT_TOKEN, process.env.PI_WEB_GITHUB_TOKEN]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result.slice(0, max);
}

function operationId(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]+(?:-[A-Za-z0-9._:-]+)*$/.test(candidate) && candidate.length <= 120 ? candidate : `op_${randomUUID()}`;
}

function publish(sessionId, type, data) {
  try { hub.emit(sessionId ?? null, type, data); } catch { /* progress must never break the operation */ }
}

export function createOperationReporter({ id = null, sessionId = null, kind = "operation", title = "Operation" } = {}) {
  const operation = {
    id: operationId(id),
    sessionId: sessionId || null,
    kind,
    title,
    status: "running",
    startedAt: Date.now(),
    events: [],
  };

  const log = (entry = {}) => {
    const event = {
      at: Date.now(),
      elapsedMs: Date.now() - operation.startedAt,
      type: entry.type || "phase",
      phase: entry.phase || null,
      message: text(entry.message || ""),
      ...(entry.command ? { command: text(entry.command) } : {}),
      ...(entry.cwd ? { cwd: text(entry.cwd, 400) } : {}),
      ...(entry.stream ? { stream: entry.stream === "stderr" ? "stderr" : "stdout" } : {}),
      ...(entry.output ? { output: text(entry.output) } : {}),
      ...(entry.durationMs != null ? { durationMs: Number(entry.durationMs) || 0 } : {}),
      ...(entry.exit != null ? { exit: Number(entry.exit) } : {}),
    };
    operation.events.push(event);
    if (operation.events.length > MAX_EVENTS) operation.events.splice(0, operation.events.length - MAX_EVENTS);
    publish(operation.sessionId, "operation_log", { operationId: operation.id, event });
    return event;
  };

  const snapshot = () => ({
    id: operation.id,
    sessionId: operation.sessionId,
    kind: operation.kind,
    title: operation.title,
    status: operation.status,
    startedAt: operation.startedAt,
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(operation.httpStatus != null ? { httpStatus: operation.httpStatus } : {}),
    ...(operation.exit != null ? { exit: operation.exit } : {}),
    events: operation.events.slice(),
  });

  const finish = ({ status = "success", httpStatus = null, exit = null, message = "" } = {}) => {
    operation.status = status;
    operation.finishedAt = Date.now();
    operation.httpStatus = httpStatus;
    operation.exit = exit;
    if (message) log({ type: status === "success" ? "result" : "error", message });
    const result = snapshot();
    publish(operation.sessionId, "operation_complete", { operationId: operation.id, operation: result });
    return result;
  };

  return {
    get id() { return operation.id; },
    get sessionId() { return operation.sessionId; },
    log,
    snapshot,
    finish,
  };
}

export function operationRequestId(c, body = {}) {
  return body?.operationId || c.req.header("x-pi-operation-id") || null;
}

export function operationResult(result, operation) {
  return operation ? { ...result, operation: operation.snapshot() } : result;
}
