// Real supervisor: pi SDK in-process. The adapter deliberately keeps Pi's
// session-entry ids as the canonical transcript identity. The web event ids
// are derived from those entries (or their known parent while an entry is
// streaming), so a snapshot and its replay address the same records.
import fs from "node:fs";
import path from "node:path";
import { loadBindings, loadConfig } from "../config.js";

let sdk = null;
async function SDK() {
  if (!sdk) sdk = await import("@earendil-works/pi-coding-agent");
  return sdk;
}

export class RealSupervisor {
  constructor(hub) {
    this.hub = hub;
    this.live = new Map();       // sessionId -> attached runtime state
    this.paths = new Map();      // sessionId -> session file path
    this.info = new Map();       // sessionId -> discovered SessionInfo metadata
    this.runtime = null;         // shared ModelRuntime for all attached sessions
    this.models = null;
  }

  async _modelRuntime() {
    if (!this.runtime) {
      const { ModelRuntime } = await SDK();
      this.runtime = await ModelRuntime.create();
    }
    return this.runtime;
  }

  async listSessions(cwd) {
    const { SessionManager } = await SDK();
    const infos = await SessionManager.list(cwd);
    for (const info of infos) this.paths.set(info.id, info.path);
    return infos.map(info => {
      let manager;
      try { manager = SessionManager.open(info.path); } catch { /* malformed/removed session */ }
      const recordedCwd = info.cwd || manager?.getCwd?.() || cwd;
      const branch = manager?.getBranch?.() || [];
      const model = modelRefFromEntries(branch);
      const item = {
        id: info.id,
        cwd: recordedCwd,
        name: info.name || null,
        parentSessionId: info.parentSessionPath ? this._idFromPath(info.parentSessionPath) : null,
        created: info.created,
        modified: info.modified,
        firstMessage: info.firstMessage || "",
        model,
      };
      this.info.set(info.id, { ...item, path: info.path, parentSessionPath: info.parentSessionPath || null });
      return item;
    });
  }

  _idFromPath(filePath) {
    for (const [id, fp] of this.paths) if (fp === filePath) return id;
    return path.basename(filePath).replace(/\.jsonl$/, "");
  }

  _boundCwd(id, fallback) {
    const bindings = loadBindings();
    return bindings[id]?.workspacePath || this.live.get(id)?.cwd || this.info.get(id)?.cwd || fallback || null;
  }

  async _discover(id) {
    if (this.paths.has(id) || this.info.has(id)) return true;
    const { SessionManager } = await SDK();
    const infos = await SessionManager.listAll();
    for (const info of infos) this.paths.set(info.id, info.path);
    const info = infos.find(item => item.id === id);
    if (!info) return false;
    this.info.set(info.id, {
      id: info.id, path: info.path, cwd: info.cwd || null,
      name: info.name || null,
      parentSessionId: info.parentSessionPath ? this._idFromPath(info.parentSessionPath) : null,
      created: info.created, modified: info.modified, firstMessage: info.firstMessage || "",
    });
    return true;
  }

  _managerFor(id, cwd) {
    const { SessionManager } = sdk || {};
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file || !SessionManager) throw new Error("unknown session " + id);
    const resolved = this._boundCwd(id, cwd);
    return SessionManager.open(file, undefined, resolved || undefined);
  }

  async _resolveModel(modelRef, runtime) {
    if (!modelRef) return undefined;
    runtime ||= await this._modelRuntime();
    const [provider, ...rest] = String(modelRef).split("/");
    const model = runtime.getModel(provider, rest.join("/"));
    if (!model) throw Object.assign(new Error("model_unavailable"), { code: "model_unavailable" });
    return model;
  }

  async _attach(id, cwd, modelRef) {
    const cached = id && this.live.get(id);
    if (cached) return cached;
    const { createAgentSession, SessionManager } = await SDK();
    const file = id && (this.paths.get(id) || this.info.get(id)?.path);
    const resolvedCwd = cwd || (id && this._boundCwd(id)) || process.cwd();
    const sessionManager = file
      ? SessionManager.open(file, undefined, resolvedCwd)
      : SessionManager.create(resolvedCwd);
    const runtime = await this._modelRuntime();
    const model = await this._resolveModel(modelRef, runtime);
    const options = { cwd: resolvedCwd, sessionManager, modelRuntime: runtime };
    if (model) options.model = model;
    const { session } = await createAgentSession(options);
    this.paths.set(session.sessionId, session.sessionFile);
    const st = {
      session,
      cwd: resolvedCwd,
      msgId: null,
      turnId: null,
      assistantParent: null,
      liveRecords: new Map(),
      toolMeta: new Map(),
    };
    st.unsubscribe = session.subscribe(evt => this._onEvent(session.sessionId, st, evt));
    this.live.set(session.sessionId, st);
    this.info.set(session.sessionId, {
      ...(this.info.get(session.sessionId) || {}),
      id: session.sessionId,
      path: session.sessionFile,
      cwd: resolvedCwd,
    });
    return st;
  }

  // ---- pi AgentEvent -> wire contract ----
  _onEvent(id, st, evt) {
    const hub = this.hub;
    switch (evt.type) {
      case "entry_appended": {
        const entry = evt.entry;
        if (entry?.type === "message" && entry.message?.role === "user") {
          const record = { id: entry.id, role: "user", text: contentText(entry.message.content) };
          st.liveRecords.clear();
          st.liveRecords.set(record.id, record);
          st.assistantParent = entry.id;
          hub.emit(id, "user_record", { record });
        }
        break;
      }
      case "agent_start":
        st.turnId = `t:${id}:${Date.now().toString(36)}`;
        st.turnEnded = false;
        hub.emit(id, "turn_start", { turnId: st.turnId });
        break;
      case "message_start":
        if (evt.message?.role === "assistant") {
          const parentId = st.session.sessionManager.getLeafId?.() || st.assistantParent || st.turnId;
          st.assistantParent = parentId;
          st.msgId = assistantRecordId(parentId);
          const record = { id: st.msgId, role: "assistant", text: "", streaming: true };
          st.liveRecords.set(st.msgId, record);
          hub.emit(id, "message_start", { messageId: st.msgId, role: "assistant" });
        }
        break;
      case "message_update": {
        const e = evt.assistantMessageEvent;
        if (e?.type === "text_delta" && e.delta && st.msgId) {
          const record = st.liveRecords.get(st.msgId);
          if (record) record.text += e.delta;
          hub.emit(id, "text_delta", { messageId: st.msgId, delta: e.delta });
        }
        break;
      }
      case "message_end":
        if (evt.message?.role === "assistant" && st.msgId) {
          const record = st.liveRecords.get(st.msgId);
          if (record) delete record.streaming;
          hub.emit(id, "message_end", { messageId: st.msgId });
        }
        break;
      case "tool_execution_start": {
        st.toolMeta.set(evt.toolCallId, { name: evt.toolName, t0: Date.now(), args: evt.args });
        const record = {
          id: evt.toolCallId, role: "tool", tool: evt.toolName,
          arg: summarizeArgs(evt.toolName, evt.args), meta: "", out: "",
        };
        st.liveRecords.set(record.id, record);
        hub.emit(id, "tool_start", {
          toolId: evt.toolCallId, name: evt.toolName,
          argsSummary: summarizeArgs(evt.toolName, evt.args),
        });
        break;
      }
      case "tool_execution_end": {
        const m = st.toolMeta.get(evt.toolCallId) || {};
        const durationMs = m.t0 ? Date.now() - m.t0 : 0;
        const output = renderToolResult(evt.result);
        const record = st.liveRecords.get(evt.toolCallId);
        if (record) {
          record.out = output;
          record.meta = [evt.isError ? "error" : "", durationMs ? (durationMs / 1000).toFixed(1) + "s" : ""].filter(Boolean).join(" · ");
        }
        hub.emit(id, "tool_end", {
          toolId: evt.toolCallId, ok: !evt.isError, output,
          meta: "", durationMs,
        });
        const diff = maybeDiff(evt.toolName, m.args, evt.result);
        if (diff) {
          const diffRecord = { id: `${evt.toolCallId}:d`, role: "diff", file: diff.path, add: `+${diff.adds}`, del: `−${diff.dels}`, lines: flattenHunks(diff.hunks) };
          st.liveRecords.set(diffRecord.id, diffRecord);
          hub.emit(id, "diff", { toolId: evt.toolCallId, ...diff });
        }
        break;
      }
      case "agent_end": {
        if (st.turnEnded) break;
        const reason = st.aborted ? "stopped" : "done";
        st.aborted = false;
        st.turnEnded = true;
        hub.emit(id, "turn_end", { turnId: st.turnId, reason });
        break;
      }
      case "session_info_changed":
        hub.emit(id, "session_meta", { name: st.session.sessionName });
        break;
      case "queue_update":
        hub.emit(id, "queue_update", {
          steering: evt.steering?.length ?? 0,
          followUp: evt.followUp?.length ?? 0,
        });
        break;
      default: break;
    }
  }

  async createSession({ cwd, name, model }) {
    const st = await this._attach(null, cwd, model || await this.defaultModel());
    if (name) st.session.setSessionName(name);
    return { id: st.session.sessionId };
  }

  async message(id, text, mode) {
    const st = await this._attachById(id);
    if (mode === "steer" && st.session.isStreaming) return st.session.steer(text);
    if (mode === "followUp" && st.session.isStreaming) return st.session.followUp(text);
    st.session.prompt(text).catch(err => {
      if (st.turnEnded) return;
      st.turnEnded = true;
      this.hub.emit(id, "turn_end", { turnId: st.turnId, reason: "errored", error: String(err?.message || err) });
    });
  }

  async _attachById(id) {
    const st = this.live.get(id);
    if (st) return st;
    await this._discover(id);
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file) throw new Error("unknown session " + id);
    return this._attach(id, this._boundCwd(id));
  }

  async stop(id) {
    const st = this.live.get(id);
    if (!st) return;
    st.aborted = true;
    await st.session.abort();
  }

  isStreaming(id) { return !!this.live.get(id)?.session?.isStreaming; }
  activeInCwd(cwd, exceptId) {
    for (const [id, st] of this.live) {
      if (id !== exceptId && st.cwd === cwd && st.session.isStreaming) return id;
    }
    return null;
  }

  async transcript(id) {
    const st = await this._attachById(id).catch(() => null);
    if (!st) return [];
    return snapshotRecords(st);
  }

  async meta(id) {
    await this._discover(id);
    const live = this.live.get(id);
    if (live) {
      return {
        id, cwd: this._boundCwd(id, live.cwd), name: live.session.sessionName || null,
        model: modelRef(live.session.model),
        parentSessionId: this.info.get(id)?.parentSessionId || null,
      };
    }
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file) return null;
    try {
      const manager = this._managerFor(id);
      const branch = manager.getBranch();
      const info = this.info.get(id) || {};
      return {
        id,
        cwd: this._boundCwd(id, manager.getCwd()),
        name: manager.getSessionName?.() || info.name || null,
        model: modelRefFromEntries(branch) || await this.defaultModel(),
        parentSessionId: info.parentSessionId || null,
      };
    } catch { return null; }
  }

  async rehome(id, newCwd) {
    const st = this.live.get(id);
    if (st) {
      if (st.session.isStreaming) throw Object.assign(new Error("busy"), { code: "workspace_busy" });
      st.unsubscribe?.();
      st.session.dispose?.();
      this.live.delete(id);
    }
    await this._attach(id, newCwd);
    this.info.set(id, { ...(this.info.get(id) || {}), cwd: newCwd });
  }

  async listModels() {
    const runtime = await this._modelRuntime();
    let models = runtime.getAvailableSnapshot?.() || [];
    if (!models.length) {
      try { models = await runtime.getAvailable(); } catch { /* no configured provider/auth */ }
    }
    this.models = models.map(modelInfo);
    return this.models.map(m => ({ ...m }));
  }

  async defaultModel() {
    const configured = loadConfig().defaultModel;
    const models = await this.listModels();
    if (configured && models.some(m => m.id === configured)) return configured;
    return models[0]?.id || configured || null;
  }

  async setModel(id, modelRef) {
    const st = await this._attachById(id);
    const runtime = st.session.modelRuntime || await this._modelRuntime();
    const model = await this._resolveModel(modelRef, runtime);
    await st.session.setModel(model);
    this.hub.emit(id, "session_meta", { model: modelRef });
  }

  async setName(id, name) {
    const st = await this._attachById(id);
    st.session.setSessionName(name);
  }

  async fork(parentId, atRecordId, { cwd, name }) {
    const { SessionManager, createAgentSession } = await SDK();
    await this._discover(parentId);
    const src = this.paths.get(parentId) || this.info.get(parentId)?.path;
    if (!src) throw new Error("unknown parent session");
    const sm = SessionManager.forkFrom(src, cwd);
    const entry = atRecordId ? sm.getEntry(atRecordId) : null;
    if (atRecordId && (!entry || entry.type !== "message" || entry.message?.role !== "user")) {
      throw Object.assign(new Error("bad_fork_record"), { code: "bad_fork_record" });
    }
    if (entry && !entry.parentId) sm.resetLeaf();
    const runtime = await this._modelRuntime();
    const { session } = await createAgentSession({ cwd, sessionManager: sm, modelRuntime: runtime });
    if (entry?.parentId) await session.navigateTree(entry.parentId);
    if (name) session.setSessionName(name);
    const id = session.sessionId;
    this.paths.set(id, session.sessionFile);
    this.info.set(id, { id, path: session.sessionFile, cwd, parentSessionId: parentId });
    const st = {
      session, cwd, msgId: null, turnId: null, assistantParent: null,
      liveRecords: new Map(), toolMeta: new Map(), parentSessionId: parentId,
    };
    st.unsubscribe = session.subscribe(evt => this._onEvent(id, st, evt));
    this.live.set(id, st);
    return { id };
  }

  async bangRecord(id, rec) {
    const st = await this._attachById(id);
    const manager = st.session.sessionManager;
    manager.appendCustomEntry("pi-web:bang", {
      id: rec.id, cmd: rec.cmd, meta: rec.meta, out: rec.out,
    });
    // The SDK intentionally defers writing a new session until its first
    // assistant message. A bang is allowed before that, so flush the same
    // SessionManager entry list through its existing writer when necessary.
    const file = manager.getSessionFile?.();
    if (file && !fs.existsSync(file)) {
      if (typeof manager._rewriteFile !== "function") {
        throw Object.assign(new Error("bang_persistence_unavailable"), { code: "bang_persistence_unavailable" });
      }
      manager._rewriteFile();
      manager.flushed = true;
    }
  }
}

function modelRef(model) {
  if (!model) return null;
  const provider = model.provider;
  const id = model.id ?? model.modelId;
  return provider && id ? `${provider}/${id}` : null;
}

function modelInfo(model) {
  const id = modelRef(model);
  return {
    id,
    provider: model.provider,
    label: model.name || model.label || model.modelId || model.id || id,
  };
}

function modelRefFromEntries(entries) {
  const entry = [...(entries || [])].reverse().find(e => e.type === "model_change");
  return entry ? `${entry.provider}/${entry.modelId}` : null;
}

function assistantRecordId(parentId) { return `a:${parentId || "root"}`; }

function snapshotRecords(st) {
  const records = entriesToRecords(st.session.sessionManager.getBranch?.() || []);
  for (const record of st.liveRecords.values()) {
    const existing = records.find(r => r.id === record.id);
    if (!existing) records.push(cloneRecord(record));
    else if (record.streaming) Object.assign(existing, { text: record.text, streaming: true });
  }
  return records;
}

export function entriesToRecords(entries) {
  const records = [];
  const tools = new Map();
  for (const entry of entries || []) {
    if (entry.type === "custom" && entry.customType === "pi-web:bang") {
      const d = entry.data || {};
      records.push({ id: d.id || entry.id, role: "bang", cmd: d.cmd || "", meta: d.meta || "", out: d.out || "" });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message || {};
    if (message.role === "user") {
      records.push({ id: entry.id, role: "user", text: contentText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = contentText((Array.isArray(message.content) ? message.content : []).filter(c => c?.type === "text"));
      if (text) records.push({ id: assistantRecordId(entry.parentId), role: "assistant", text });
      for (const c of Array.isArray(message.content) ? message.content : []) {
        if (c?.type === "toolCall") {
          const record = { id: c.id, role: "tool", tool: c.name, arg: summarizeArgs(c.name, c.arguments || c.args), meta: "", out: "" };
          records.push(record);
          tools.set(c.id, record);
        }
      }
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool_result" || message.role === "tool") {
      const toolId = message.toolCallId || message.tool_call_id || message.id;
      const record = tools.get(toolId) || [...records].reverse().find(r => r.role === "tool" && !r.out);
      if (record) record.out = renderToolResult(message);
    }
  }
  return records;
}

function cloneRecord(record) {
  return { ...record, ...(record.lines ? { lines: record.lines.map(line => ({ ...line })) } : {}) };
}

function flattenHunks(hunks) {
  return (hunks || []).flatMap(h => [
    ...(h.header ? [{ sign: "", text: h.header }] : []),
    ...(h.lines || []),
  ]);
}

export function summarizeArgs(toolName, args) {
  if (!args || typeof args !== "object") return "";
  const v = args.path || args.file_path || args.pattern || args.command || args.cmd || Object.values(args)[0];
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function renderToolResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content.map(c => (typeof c === "string" ? c : c.text ?? "")).join("\n");
  }
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

export function maybeDiff(toolName, args, result) {
  if (toolName !== "edit" && toolName !== "write") return null;
  const filePath = args?.path || args?.file_path;
  const text = renderToolResult(result);
  if (!filePath || !text || !/^[@+\- ]/m.test(text)) return null;
  const lines = [];
  let adds = 0, dels = 0;
  const hunks = [];
  let hunk = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      hunk = { header: raw, lines: [] };
      hunks.push(hunk);
      continue;
    }
    const sign = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
    if (sign === "+") adds++; else if (sign === "-") dels++;
    const line = { sign, text: raw.replace(/^[+\- ]/, "") };
    (hunk ? hunk.lines : lines).push(line);
  }
  if (!hunks.length && lines.length) hunks.push({ header: "", lines });
  if (!hunks.length) return null;
  return { path: filePath, adds, dels, hunks };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c?.text ?? "").join("");
  return "";
}
