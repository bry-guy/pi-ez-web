// Real supervisor: pi SDK in-process. Written against the installed
// @earendil-works/pi-coding-agent API (verified exports: createAgentSession,
// SessionManager.{create,open,list,forkFrom}, AgentSession.{prompt,steer,
// followUp,abort,setModel,setSessionName,subscribe,navigateTree,messages}).
// The end-to-end validation of this file is `npm run verify:real` on a
// machine with ~/.pi/agent configured.
import path from "node:path";
import { newId } from "../config.js";

let sdk = null;
async function SDK() {
  if (!sdk) sdk = await import("@earendil-works/pi-coding-agent");
  return sdk;
}

export class RealSupervisor {
  constructor(hub) {
    this.hub = hub;
    this.live = new Map();   // sessionId -> { session, unsubscribe, cwd, msgId, turnId, sawText, toolMeta }
    this.paths = new Map();  // sessionId -> session file path
  }

  async listSessions(cwd) {
    const { SessionManager } = await SDK();
    const infos = await SessionManager.list(cwd);
    for (const i of infos) this.paths.set(i.id, i.path);
    return infos.map(i => ({
      id: i.id, cwd: i.cwd || cwd, name: i.name || null,
      parentSessionId: i.parentSessionPath ? this._idFromPath(i.parentSessionPath) : null,
      created: i.created, modified: i.modified,
      firstMessage: i.firstMessage || "",
    }));
  }
  _idFromPath(p) {
    for (const [id, fp] of this.paths) if (fp === p) return id;
    return path.basename(p).replace(/\.jsonl$/, "");
  }

  async _attach(id, cwd) {
    const cached = this.live.get(id);
    if (cached) return cached;
    const { createAgentSession, SessionManager } = await SDK();
    const file = this.paths.get(id);
    const sessionManager = file
      ? SessionManager.open(file, undefined, cwd) // cwdOverride = re-home support
      : SessionManager.create(cwd);
    const { session } = await createAgentSession({ cwd, sessionManager });
    this.paths.set(session.sessionId, session.sessionFile);
    const st = { session, cwd, msgId: null, turnId: null, sawText: false, toolMeta: new Map() };
    st.unsubscribe = session.subscribe(evt => this._onEvent(session.sessionId, st, evt));
    this.live.set(session.sessionId, st);
    return st;
  }

  // ---- pi AgentEvent -> wire contract ----
  _onEvent(id, st, evt) {
    const hub = this.hub;
    switch (evt.type) {
      case "agent_start":
        st.turnId = newId("t");
        hub.emit(id, "turn_start", { turnId: st.turnId });
        break;
      case "message_start":
        if (evt.message?.role === "assistant") {
          st.msgId = newId("m");
          st.sawText = false;
          hub.emit(id, "message_start", { messageId: st.msgId, role: "assistant" });
        }
        break;
      case "message_update": {
        const e = evt.assistantMessageEvent;
        if (e?.type === "text_delta" && e.delta) {
          st.sawText = true;
          hub.emit(id, "text_delta", { messageId: st.msgId, delta: e.delta });
        }
        break;
      }
      case "message_end":
        if (evt.message?.role === "assistant" && st.msgId) {
          hub.emit(id, "message_end", { messageId: st.msgId });
        }
        break;
      case "tool_execution_start": {
        st.toolMeta.set(evt.toolCallId, { name: evt.toolName, t0: Date.now(), args: evt.args });
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
        hub.emit(id, "tool_end", {
          toolId: evt.toolCallId, ok: !evt.isError, output,
          meta: "", durationMs,
        });
        const diff = maybeDiff(evt.toolName, m.args, evt.result);
        if (diff) hub.emit(id, "diff", { toolId: evt.toolCallId, ...diff });
        break;
      }
      case "agent_end": {
        const reason = st.aborted ? "stopped" : "done";
        st.aborted = false;
        hub.emit(id, "turn_end", { turnId: st.turnId, reason });
        break;
      }
      case "session_info_changed":
        hub.emit(id, "session_meta", { name: st.session.sessionName });
        break;
      case "queue_update":
        hub.emit(id, "queue_update", {
          steering: evt.queue?.steering?.length ?? 0,
          followUp: evt.queue?.followUp?.length ?? 0,
        });
        break;
      default: break;
    }
  }

  async createSession({ cwd, name }) {
    const st = await this._attach(null, cwd); // no file -> SessionManager.create
    if (name) st.session.setSessionName(name);
    return { id: st.session.sessionId };
  }

  async message(id, text, mode) {
    const st = await this._attachById(id);
    if (mode === "steer" && st.session.isStreaming) return st.session.steer(text);
    if (mode === "followUp" && st.session.isStreaming) return st.session.followUp(text);
    // fire-and-forget: prompt resolves at end of turn; events stream meanwhile
    st.session.prompt(text).catch(err => {
      this.hub.emit(id, "turn_end", { turnId: st.turnId, reason: "errored", error: String(err?.message || err) });
    });
  }

  async _attachById(id) {
    const st = this.live.get(id);
    if (st) return st;
    const file = this.paths.get(id);
    if (!file) throw new Error("unknown session " + id);
    // cwd recorded in the session file; SessionManager.open resolves it
    return this._attach(id, path.dirname(file));
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
    return messagesToRecords(st.session.messages);
  }

  async meta(id) {
    const st = this.live.get(id);
    if (!st) return null;
    return {
      id, cwd: st.cwd, name: st.session.sessionName || null,
      model: st.session.model ? `${st.session.model.provider}/${st.session.model.modelId ?? st.session.model.id ?? ""}` : null,
      parentSessionId: null,
    };
  }

  async rehome(id, newCwd) {
    // Re-open the same session file with a cwd override; only when idle.
    const st = this.live.get(id);
    if (st) {
      if (st.session.isStreaming) throw Object.assign(new Error("busy"), { code: "workspace_busy" });
      st.unsubscribe?.();
      st.session.dispose?.();
      this.live.delete(id);
    }
    await this._attach(id, newCwd);
  }

  async setModel(id, modelRef) {
    const st = await this._attachById(id);
    const { ModelRegistry } = await SDK();
    // modelRef: "provider/modelId"
    const [provider, ...rest] = String(modelRef).split("/");
    const registry = st.session.modelRegistry || ModelRegistry.create?.();
    const model = registry?.find?.(provider, rest.join("/"));
    if (model) await st.session.setModel(model);
    this.hub.emit(id, "session_meta", { model: modelRef });
  }

  async setName(id, name) {
    const st = await this._attachById(id);
    st.session.setSessionName(name);
  }

  async fork(parentId, atRecordId, { cwd, name }) {
    const { SessionManager } = await SDK();
    const src = this.paths.get(parentId);
    if (!src) throw new Error("unknown parent session");
    const sm = SessionManager.forkFrom(src, cwd);
    const { createAgentSession } = await SDK();
    const { session } = await createAgentSession({ cwd, sessionManager: sm });
    // Rewind the fork to just before the forked user message when resolvable.
    try {
      if (atRecordId && typeof session.navigateTree === "function") {
        await session.navigateTree(atRecordId, { toParent: true });
      }
    } catch { /* fork keeps full history if navigation fails; verify:real checks this */ }
    if (name) session.setSessionName(name);
    const id = session.sessionId;
    this.paths.set(id, session.sessionFile);
    const st = { session, cwd, msgId: null, turnId: null, toolMeta: new Map() };
    st.unsubscribe = session.subscribe(evt => this._onEvent(id, st, evt));
    this.live.set(id, st);
    return { id };
  }

  async bangRecord(id, rec) {
    // Persisting bang output into pi's JSONL as a custom entry is desirable but
    // API-dependent; keep it live-only in v1 (rendered from events; absent from
    // cold snapshots in real mode). Revisit with appendCustomEntry if exposed.
    void id; void rec;
  }
}

// ---- mapping helpers ----
export function summarizeArgs(toolName, args) {
  if (!args || typeof args !== "object") return "";
  const v = args.path || args.file_path || args.pattern || args.command || args.cmd || Object.values(args)[0];
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function renderToolResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content.map(c => (typeof c === "string" ? c : c.text ?? "")).join("\n");
  }
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// Recognize edit-tool results and produce the structured diff shape; anything
// unparseable degrades to a plain tool_end (never a malformed diff).
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

// Cold-snapshot mapping: AgentSession.messages -> five-role records.
export function messagesToRecords(messages) {
  const records = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      const text = contentText(m.content);
      if (text) records.push({ id: newId("m"), role: "user", text });
    } else if (m.role === "assistant") {
      for (const c of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
        if (c?.type === "text" && c.text) {
          records.push({ id: newId("m"), role: "assistant", text: c.text });
        } else if (c?.type === "toolCall") {
          records.push({
            id: c.id || newId("tc"), role: "tool", tool: c.name,
            arg: summarizeArgs(c.name, c.arguments || c.args), meta: "", out: "",
          });
        }
      }
    } else if (m.role === "toolResult" || m.role === "tool_result" || m.role === "tool") {
      const last = [...records].reverse().find(r => r.role === "tool" && !r.out);
      if (last) last.out = renderToolResult(m);
    }
  }
  return records;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c?.text ?? "").join("");
  return "";
}
