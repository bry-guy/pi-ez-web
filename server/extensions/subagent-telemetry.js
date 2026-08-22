// Headless Pi extension bridge for pi-subagents.
//
// pi-subagents deliberately keeps its manager and TUI state private. It does,
// however, expose a small event bus for lifecycle integrations. This bridge
// turns only bounded lifecycle/progress snapshots into durable, non-display
// custom entries. The web supervisor consumes those entries and owns the live
// projection; no browser-facing code runs inside this extension.
import { normalizeSubagentActivity } from "../subagent-activity.js";

const CHANNELS = [
  "subagents:created",
  "subagents:started",
  "subagents:progress",
  "subagents:steered",
  "subagents:compacted",
  "subagents:grouped",
  "subagents:completed",
  "subagents:failed",
];
const MAX_PROGRESS_MS = 250;

function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function now() { return new Date().toISOString(); }

export default function subagentTelemetry(pi) {
  const latest = new Map();
  const lastProgress = new Map();
  const unsubscribers = [];
  let parentMessageId = "root";

  function captureParent(ctx) {
    try {
      const leaf = ctx?.sessionManager?.getLeafId?.();
      if (typeof leaf === "string" && leaf) parentMessageId = leaf;
    } catch { /* context is optional in headless lifecycle hooks */ }
  }

  function publish(eventType, input) {
    if (!object(input) || input.parentAgentId) return;
    const runId = typeof (input.runId || input.agentId || input.id) === "string"
      ? String(input.runId || input.agentId || input.id)
      : "";
    if (!runId) return;
    const previous = latest.get(runId) || {};
    const previousTerminal = ["completed", "failed", "stopped", "aborted", "cancelled", "canceled"].includes(String(previous.status || "").toLowerCase());
    if (previousTerminal && ["created", "started", "progress", "compacted"].includes(eventType)) return;
    const merged = { ...previous, ...input, runId, eventType };
    merged.parentMessageId ||= parentMessageId;
    const revision = Math.max(Number(previous.revision) || 0, Number(input.revision) || 0) + 1;
    merged.revision = revision;
    merged.createdAt ||= input.startedAt || now();
    if (eventType === "started") merged.startedAt ||= input.startedAt || now();
    if (eventType === "completed" || eventType === "failed") merged.endedAt ||= input.completedAt || now();
    if (eventType === "created" && !merged.status) merged.status = "queued";
    if (eventType === "created" && !merged.activity) merged.activity = "waiting for a worker";
    if (eventType === "started" || eventType === "progress" || eventType === "steered" || eventType === "compacted") merged.status = "running";
    if (eventType === "started" && !input.activity) merged.activity = "working";
    if (eventType === "steered" && !input.activity) merged.activity = "processing guidance";
    if (eventType === "completed") { merged.status = "completed"; merged.activity = input.activity || ""; }
    if (eventType === "failed") { merged.status = input.status || "failed"; merged.activity = input.activity || ""; }
    latest.set(runId, merged);
    if (eventType === "progress") {
      const timestamp = Date.now();
      const last = lastProgress.get(runId) || 0;
      if (timestamp - last < MAX_PROGRESS_MS) return;
      lastProgress.set(runId, timestamp);
    }

    const normalized = normalizeSubagentActivity(merged, { eventType, source: "pi-subagents" });
    if (!normalized) return;
    // Include the captured parent because appending an earlier telemetry entry
    // moves Pi's leaf. Relying only on the custom entry parent would split one
    // parallel batch into several groups.
    const data = {
      parentMessageId: normalized.parentMessageId,
      runId: normalized.runId,
      ...(normalized.groupId ? { groupId: normalized.groupId } : {}),
      revision: normalized.revision,
      status: normalized.status,
      description: normalized.title,
      ...(normalized.activity ? { activity: normalized.activity } : {}),
      toolCount: normalized.toolCount,
      createdAt: normalized.createdAt,
      ...(normalized.startedAt ? { startedAt: normalized.startedAt } : {}),
      ...(normalized.endedAt ? { endedAt: normalized.endedAt } : {}),
      ...(normalized.summary ? { summary: normalized.summary } : {}),
      ...(normalized.error ? { error: normalized.error } : {}),
      eventType,
    };
    try {
      pi.appendEntry("pi-web:subagent", data);
    } catch {
      // Telemetry must never fail an agent run or the parent turn.
    }
  }

  pi.on("session_start", (_event, ctx) => captureParent(ctx));
  pi.on("agent_start", (_event, ctx) => captureParent(ctx));
  pi.on("tool_execution_start", (_event, ctx) => captureParent(ctx));

  for (const channel of CHANNELS) {
    try {
      const unsubscribe = pi.events.on(channel, data => publish(channel.slice("subagents:".length), data));
      if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
    } catch {
      // Older Pi hosts or sessions without the event bus simply have no bridge.
    }
  }

  pi.on("session_shutdown", () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* stale event bus */ }
    }
    latest.clear();
    lastProgress.clear();
    parentMessageId = "root";
  });
}
