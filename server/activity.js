// Safe, extension-agnostic projections for durable Pi activity.
// Extension renderers and UI objects never cross the web boundary.
const MAX_SUMMARY = 600;
const MAX_ITEMS = 100;
const MAX_PAYLOAD = 128_000;
const ACTIVITY_KINDS = new Set(["todo", "agent", "status"]);
const ACTIVITY_STATUSES = new Set([
  "pending", "in_progress", "completed", "deleted", "running", "queued",
  "failed", "stopped", "aborted", "error",
]);

function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value, fallback = "") {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_SUMMARY)
    : fallback;
}
function redact(value) {
  return text(value)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/([?&](?:token|key|code|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}
function payloadWithinLimit(value) {
  try { return JSON.stringify(value).length <= MAX_PAYLOAD; } catch { return false; }
}
function statusOf(value, fallback = "completed") {
  const status = typeof value === "string" && ACTIVITY_STATUSES.has(value) ? value : fallback;
  return status;
}
function safeTodoItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).flatMap(item => {
    if (!object(item) || (typeof item.id !== "number" && typeof item.id !== "string")) return [];
    return [{
      id: String(item.id).slice(0, 80),
      subject: redact(item.subject || item.title || ""),
      description: redact(item.description || ""),
      status: statusOf(item.status, "pending"),
      activeForm: redact(item.activeForm || ""),
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.slice(0, 20).map(String) : [],
    }];
  });
}

export function normalizeActivity(value, { id, source = "extension" } = {}) {
  if (!object(value) || !payloadWithinLimit(value)) return null;
  const kind = ACTIVITY_KINDS.has(value.kind) ? value.kind : null;
  if (!kind) return null;
  const recordId = text(value.id || id);
  const key = text(value.key || recordId);
  if (!recordId || !key) return null;
  const items = kind === "todo" ? safeTodoItems(value.items) : [];
  return {
    id: recordId,
    role: "activity",
    kind,
    key,
    status: statusOf(value.status),
    title: redact(value.title || (kind === "todo" ? "Todos" : kind === "agent" ? "Background agent" : "Activity")),
    summary: redact(value.summary || ""),
    items,
    source: text(source || value.source || "extension", "extension"),
  };
}

export function activityFromTodoDetails(details, id, source = "pi") {
  if (!object(details) || !Array.isArray(details.tasks)) return null;
  const items = safeTodoItems(details.tasks);
  const completed = items.filter(item => item.status === "completed").length;
  const active = items.filter(item => item.status === "in_progress").length;
  const status = items.length && completed === items.length
    ? "completed"
    : active ? "in_progress" : "pending";
  return normalizeActivity({
    id: `activity:todo:${text(id, "latest")}`,
    kind: "todo",
    key: "todo",
    status,
    title: "Todos",
    summary: `${completed}/${items.length} complete${active ? ` · ${active} active` : ""}`,
    items,
  }, { source });
}

export function activityFromAgentDetails(details, { id, content = "", source = "extension" } = {}) {
  if (!object(details) || (!details.id && !details.description && !details.status)) return null;
  const agentId = text(details.id || id);
  if (!agentId) return null;
  const terminalStatus = new Set(["completed", "failed", "stopped", "aborted", "error"]);
  const terminal = terminalStatus.has(details.status)
    || details.completed === true || details.done === true || details.finished === true
    || details.result !== undefined || details.resultPreview !== undefined || details.error !== undefined;
  const summary = terminal ? details.resultPreview || details.result || details.error || content : content;
  return normalizeActivity({
    id: `activity:agent:${agentId}`,
    kind: "agent",
    key: `agent:${agentId}`,
    status: statusOf(details.status, terminal ? "completed" : "running"),
    title: details.description || "Background agent",
    summary: summary || (terminal ? "Background agent finished." : "Background agent is working…"),
  }, { source });
}

export function activityFromToolResult(result, id) {
  if (!object(result)) return null;
  const details = object(result.details) ? result.details : null;
  return activityFromTodoDetails(details, id)
    || (details?.kind ? normalizeActivity(details, { id: `activity:${text(id, "result")}`, source: "extension" }) : null);
}

export function activityFromEntry(entry) {
  if (!object(entry)) return null;
  if (entry.type === "compaction") {
    return normalizeActivity({
      id: "activity:compaction", kind: "status", key: "compaction", status: "completed",
      title: "Context compacted", summary: "Session context compacted.",
    }, { source: "pi" });
  }
  if (entry.type === "message") {
    const message = entry.message;
    if (!object(message)) return null;
    if (message.role === "toolResult" || message.role === "tool_result" || message.role === "tool") {
      return activityFromToolResult(message, message.toolCallId || message.id || entry.id);
    }
    if (message.role === "custom") {
      return activityFromCustom(entry.id, message.customType, message.details, message.content);
    }
    return null;
  }
  if (entry.type === "custom_message") {
    return activityFromCustom(entry.id, entry.customType, entry.details, entry.content);
  }
  if (entry.type === "custom") {
    return activityFromCustom(entry.id, entry.customType, entry.data);
  }
  return null;
}

function activityFromCustom(id, customType, details, content = "") {
  if (customType === "pi-web:activity") return normalizeActivity(details, { id, source: "extension" });
  if (customType === "subagents:record" || customType === "subagent-notification") {
    return activityFromAgentDetails(details, { id, content: typeof content === "string" ? content : "", source: "pi-subagents" });
  }
  return null;
}
