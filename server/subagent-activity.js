// Safe live projections for pi-subagents. This module is intentionally free of
// Pi SDK and browser dependencies: the headless bridge and supervisor both use
// the same bounded data contract.

export const SUBAGENT_STATUSES = new Set([
  "queued", "running", "completed", "failed", "cancelled",
]);
export const MAX_SUBAGENT_TEXT = 600;
export const MAX_SUBAGENT_ID = 160;
export const MAX_SUBAGENT_RECORDS = 100;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export function isTerminalSubagentStatus(status) {
  return TERMINAL.has(status);
}

function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function redactSubagentText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "gh_[redacted]")
    .replace(/([?&](?:token|key|code|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, MAX_SUBAGENT_TEXT);
}

function id(value, fallback = "") {
  return redactSubagentText(value, fallback).slice(0, MAX_SUBAGENT_ID);
}

function integer(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function iso(value, fallback = null) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export function normalizeSubagentStatus(value, fallback = "running") {
  const status = String(value || "").trim().toLowerCase();
  if (status === "stopped" || status === "stop" || status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "error" || status === "aborted" || status === "failed" || status === "failure") return "failed";
  if (status === "steered") return "completed";
  if (SUBAGENT_STATUSES.has(status)) return status;
  return fallback;
}

function eventStatus(value, eventType, details = {}) {
  const type = String(eventType || "").trim().toLowerCase();
  if (type === "created") return normalizeSubagentStatus(value, "queued");
  if (type === "started" || type === "progress" || type === "compacted") return "running";
  if (type === "completed") return "completed";
  if (type === "failed") return "failed";
  if (!value && details.error !== undefined) return "failed";
  if (!value && (details.result !== undefined || details.resultPreview !== undefined)) return "completed";
  return normalizeSubagentStatus(value, "running");
}

function terminalSummary(value, status, fallback = "") {
  if (!isTerminalSubagentStatus(status)) return "";
  const summary = value.resultPreview ?? value.result ?? value.error ?? value.summary ?? fallback;
  let output = redactSubagentText(summary, "");
  if (String(value.status || "").toLowerCase() === "aborted" && output) {
    output = `Aborted before completion. ${output}`;
  } else if (String(value.status || "").toLowerCase() === "steered" && output) {
    output = `Wrapped up at the turn limit. ${output}`;
  }
  return output;
}

/**
 * Normalize a bridge event, transcript custom entry, or legacy notification.
 * `entryId` is only a fallback; runId is the canonical identity.
 */
export function normalizeSubagentActivity(value, {
  entryId = null,
  parentMessageId = null,
  content = "",
  source = "pi-subagents",
  eventType = "",
} = {}) {
  if (!object(value)) return null;
  const runId = id(value.runId || value.agentId || value.id || entryId);
  if (!runId) return null;
  const status = eventStatus(value.status, value.event || value.eventType || eventType, value);
  const createdAt = iso(value.createdAt || value.startedAt || value.timestamp, nowIso());
  const startedAt = iso(value.startedAt, status === "running" ? createdAt : null);
  const endedAt = iso(value.endedAt || value.completedAt, isTerminalSubagentStatus(status) ? (value.completedAt || value.endedAt || createdAt) : null);
  const description = redactSubagentText(value.description || value.title || value.name, "Background agent");
  const activity = redactSubagentText(value.activity || value.phase || value.currentActivity, "");
  const summary = terminalSummary(value, status, content);
  const rawParent = value.parentMessageId || parentMessageId || "root";
  const parent = id(rawParent, "root");
  const groupId = id(value.groupId, "");
  const revision = integer(value.revision, 1) || 1;
  const record = {
    id: `activity:agent:${runId}`,
    role: "activity",
    kind: "agent",
    key: `agent:${runId}`,
    runId,
    ...(groupId ? { groupId } : {}),
    parentMessageId: parent,
    revision,
    status,
    title: description || "Background agent",
    activity,
    toolCount: integer(value.toolCount ?? value.toolUses, 0),
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    summary,
    ...(redactSubagentText(value.error, "") ? { error: redactSubagentText(value.error, "") } : {}),
    source: redactSubagentText(source, "pi-subagents") || "pi-subagents",
  };
  return record;
}

function clone(record) {
  return { ...record };
}

/**
 * Per-session source of truth for live subagent cards. Transcript entries are
 * inputs/recovery; callers emit a record only when apply() returns non-null.
 */
export class SubagentActivityStore {
  constructor({ maxRecords = MAX_SUBAGENT_RECORDS } = {}) {
    this.maxRecords = Math.max(1, Math.min(MAX_SUBAGENT_RECORDS, Number(maxRecords) || MAX_SUBAGENT_RECORDS));
    this.records = new Map();
  }

  applyEvent(eventType, value, options = {}) {
    if (!object(value)) return null;
    const type = String(eventType || value.eventType || value.event || "").trim().toLowerCase();
    const runId = id(value.runId || value.agentId || value.id);
    if (!runId) return null;
    const existing = this.records.get(runId);
    const terminalEvent = type === "completed" || type === "failed";
    if (existing && isTerminalSubagentStatus(existing.status)
      && (!terminalEvent || existing.status !== type)) return null;

    const merged = existing
      ? { ...existing, runId, id: runId, description: existing.title, summary: existing.summary, ...value }
      : { ...value };
    merged.runId = runId;
    merged.eventType = type;
    const suppliedRevision = Number(value.revision);
    merged.revision = Number.isSafeInteger(suppliedRevision) && suppliedRevision > 0
      ? suppliedRevision
      : (Number(existing?.revision) || 0) + 1;
    if (!existing && type === "created" && value.activity === undefined) merged.activity = "waiting for a worker";
    if (type === "started") {
      if (value.activity === undefined) merged.activity = "working";
      merged.startedAt ||= value.startedAt || nowIso();
    }
    if (type === "steered" && value.activity === undefined) merged.activity = "processing guidance";
    if (terminalEvent) {
      if (value.activity === undefined) merged.activity = "";
      merged.endedAt ||= value.completedAt || nowIso();
    }

    const record = normalizeSubagentActivity(merged, {
      ...options,
      eventType: type,
      parentMessageId: merged.parentMessageId || options.parentMessageId,
    });
    if (!record) return null;
    if (!record.summary && existing?.summary) record.summary = redactSubagentText(existing.summary, "");
    return this.apply(record, { revisionProvided: true });
  }

  apply(value, options = {}) {
    const revisionProvided = options.revisionProvided ?? (Number.isSafeInteger(Number(value?.revision)) && Number(value.revision) > 0);
    const incoming = value?.role === "activity" && value?.kind === "agent"
      ? clone(value)
      : normalizeSubagentActivity(value, options);
    if (!incoming) return null;
    const existing = this.records.get(incoming.runId);
    const incomingTerminal = isTerminalSubagentStatus(incoming.status);
    if (existing) {
      const existingTerminal = isTerminalSubagentStatus(existing.status);
      // A terminal state can never be regressed by a late progress event, and
      // a started run must not be moved back to queued by the created event
      // that some Pi-subagents versions emit after start.
      if (existingTerminal && (!incomingTerminal || existing.status !== incoming.status)) return null;
      if (existing.status === "running" && incoming.status === "queued") return null;
      const revision = revisionProvided ? Number(incoming.revision) || 1 : (Number(existing.revision) || 0) + 1;
      const currentRevision = Number(existing.revision) || 1;
      const richerTerminal = incomingTerminal && (
        incoming.summary && incoming.summary !== existing.summary
        || incoming.error && incoming.error !== existing.error
        || incoming.groupId && incoming.groupId !== existing.groupId
      );
      if (revision <= currentRevision && !(incomingTerminal && (!existingTerminal || richerTerminal))) return null;
      incoming.revision = Math.max(revision, currentRevision + (revision <= currentRevision ? 1 : 0));
      incoming.createdAt ||= existing.createdAt;
      incoming.startedAt ||= existing.startedAt;
      if (!incoming.summary && existing.summary) incoming.summary = existing.summary;
      if (!incoming.activity && existing.activity && !incomingTerminal) incoming.activity = existing.activity;
      if (!incoming.groupId && existing.groupId) incoming.groupId = existing.groupId;
      if (!incoming.parentMessageId || incoming.parentMessageId === "root") incoming.parentMessageId = existing.parentMessageId;
    }
    if (!revisionProvided && !existing) incoming.revision = 1;
    this.records.set(incoming.runId, incoming);
    this.prune();
    return clone(incoming);
  }

  clear() {
    this.records.clear();
  }

  snapshot() {
    return [...this.records.values()]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.runId.localeCompare(b.runId))
      .map(clone);
  }

  prune() {
    if (this.records.size <= this.maxRecords) return;
    const removable = [...this.records.values()]
      .filter(record => isTerminalSubagentStatus(record.status))
      .sort((a, b) => String(a.endedAt || a.createdAt).localeCompare(String(b.endedAt || b.createdAt)));
    while (this.records.size > this.maxRecords && removable.length) {
      this.records.delete(removable.shift().runId);
    }
  }
}
