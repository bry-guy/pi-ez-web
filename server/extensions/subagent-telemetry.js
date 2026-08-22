// Headless Pi extension bridge for pi-subagents.
//
// pi-subagents deliberately keeps its manager and TUI state private. It does,
// however, expose a small event bus for lifecycle integrations. This bridge
// turns only bounded lifecycle/progress snapshots into durable, non-display
// custom entries. The web supervisor consumes those entries and owns the live
// projection; no browser-facing code runs inside this extension.
import { SubagentActivityStore } from "../subagent-activity.js";

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

export default function subagentTelemetry(pi) {
  const activityStore = new SubagentActivityStore();
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
    if (eventType === "progress") {
      const timestamp = Date.now();
      const last = lastProgress.get(runId) || 0;
      if (timestamp - last < MAX_PROGRESS_MS) return;
      lastProgress.set(runId, timestamp);
    }

    const record = activityStore.applyEvent(eventType, input, {
      parentMessageId,
      source: "pi-subagents",
    });
    if (!record) return;
    // Include the captured parent because appending an earlier telemetry entry
    // moves Pi's leaf. Relying only on the custom entry parent would split one
    // parallel batch into several groups.
    const data = {
      parentMessageId: record.parentMessageId,
      runId: record.runId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      revision: record.revision,
      status: record.status,
      description: record.title,
      ...(record.activity ? { activity: record.activity } : {}),
      toolCount: record.toolCount,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      ...(record.error ? { error: record.error } : {}),
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
    activityStore.clear();
    lastProgress.clear();
    parentMessageId = "root";
  });
}
