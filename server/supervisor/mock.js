// Mock supervisor: same interface as the real one, scripted turns.
// Exercises the full event contract (thinking -> deltas -> tool -> diff ->
// done, stop/steer/followUp, bang) and persists transcripts under the app
// home so snapshot/reconnect and discovery are tested for real.
import fs from "node:fs";
import path from "node:path";
import { appHome, loadConfig, newId } from "../config.js";
import { WEB_PI_COMMANDS, parseSlashCommand } from "../commands.js";

const MOCK_MODELS = [
  { id: "mock/fast", provider: "mock", label: "Mock Fast" },
  { id: "mock/smart", provider: "mock", label: "Mock Smart" },
];

const THINK_MS = () => Number(process.env.PI_WEB_MOCK_THINK_MS ?? 900);
const DELTA_MS = () => Number(process.env.PI_WEB_MOCK_DELTA_MS ?? 18);

const dir = () => path.join(appHome(), "mock-sessions");
const fileOf = id => path.join(dir(), id + ".json");

export class MockSupervisor {
  constructor(hub) {
    this.hub = hub;
    this.live = new Map(); // id -> { timers, queue, streaming }
  }

  // ---- storage ----
  _load(id) {
    try { return JSON.parse(fs.readFileSync(fileOf(id), "utf8")); } catch { return null; }
  }
  _save(s) {
    s.modified = new Date().toISOString();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileOf(s.id), JSON.stringify(s));
  }

  // ---- interface ----
  async listSessions(cwd) {
    let files = [];
    try { files = fs.readdirSync(dir()); } catch { return []; }
    return files.map(f => this._load(path.basename(f, ".json")))
      .filter(s => s && s.cwd === cwd)
      .map(s => ({
        id: s.id, cwd: s.cwd, name: s.name,
        parentSessionId: s.parentSessionId || null,
        created: s.created, modified: s.modified,
        firstMessage: (s.records.find(r => r.role === "user") || {}).text || "",
        model: s.model || this.defaultModel(),
      }));
  }

  listModels() { return MOCK_MODELS.map(m => ({ ...m })); }
  defaultModel() {
    const configured = loadConfig().defaultModel || null;
    return configured ? (MOCK_MODELS.some(m => m.id === configured) ? configured : null) : MOCK_MODELS[0].id;
  }
  modelState() {
    const configuredDefault = loadConfig().defaultModel || null;
    const effectiveDefault = configuredDefault
      ? (MOCK_MODELS.some(m => m.id === configuredDefault) ? configuredDefault : null)
      : MOCK_MODELS[0].id;
    return {
      models: this.listModels(),
      configuredDefault,
      effectiveDefault,
      status: configuredDefault ? (effectiveDefault === configuredDefault ? "available" : "unavailable") : "automatic",
      error: null,
    };
  }
  listProviders() {
    return [{
      id: "mock",
      name: "Mock provider",
      configured: true,
      source: "runtime",
      sourceLabel: "Scripted",
      authType: null,
      authMethods: [],
      availableModels: MOCK_MODELS.length,
      canLogout: false,
      error: null,
    }];
  }
  async loginProvider() { throw Object.assign(new Error("unsupported_auth_type"), { code: "unsupported_auth_type" }); }
  async logoutProvider() { throw Object.assign(new Error("unsupported_auth_type"), { code: "unsupported_auth_type" }); }
  async commands() { return WEB_PI_COMMANDS.map(command => ({ ...command })); }
  async command(id, text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) throw Object.assign(new Error("invalid_slash_command"), { code: "invalid_slash_command" });
    if (parsed.name === "settings") return { action: "settings" };
    if (parsed.name === "name") {
      if (!parsed.args.trim()) throw Object.assign(new Error("usage: /name <name>"), { code: "command_usage" });
      await this.setName(id, parsed.args.trim());
      return { action: "session_meta", name: parsed.args.trim() };
    }
    throw Object.assign(new Error("unknown_slash_command"), { code: "unknown_slash_command" });
  }

  async createSession({ cwd, name, model }) {
    const s = {
      id: newId("s"), cwd, name: name || null, model: model || this.defaultModel(),
      parentSessionId: null, created: new Date().toISOString(), records: [],
    };
    this._save(s);
    return { id: s.id };
  }

  async transcript(id) {
    const s = this._load(id);
    return s ? s.records : [];
  }
  async meta(id) {
    const s = this._load(id);
    return s ? { id: s.id, cwd: s.cwd, name: s.name, model: s.model, parentSessionId: s.parentSessionId } : null;
  }
  isStreaming(id) { return !!this.live.get(id)?.streaming; }
  activeInCwd(cwd, exceptId) {
    for (const [id, st] of this.live) {
      if (id === exceptId || !st.streaming) continue;
      const s = this._load(id);
      if (s && s.cwd === cwd) return id;
    }
    return null;
  }

  async rehome(id, newCwd) {
    const s = this._load(id);
    if (!s) throw new Error("no such session");
    s.cwd = newCwd;
    this._save(s);
  }

  async setModel(id, model) {
    const s = this._load(id);
    if (!s || !MOCK_MODELS.some(m => m.id === model)) {
      throw Object.assign(new Error("model_unavailable"), { code: "model_unavailable" });
    }
    s.model = model;
    this._save(s);
    this.hub.emit(id, "session_meta", { model });
  }

  async setName(id, name) {
    const s = this._load(id);
    s.name = name;
    this._save(s);
    this.hub.emit(id, "session_meta", { name });
  }

  // Fork transcript at (before) a user message; new session in newCwd.
  async fork(parentId, atRecordId, { cwd, name }) {
    const p = this._load(parentId);
    const idx = p.records.findIndex(r => r.id === atRecordId);
    const kept = idx > 0 ? p.records.slice(0, idx) : [];
    const s = {
      id: newId("s"), cwd, name: name || null, model: p.model,
      parentSessionId: parentId, created: new Date().toISOString(),
      records: kept,
    };
    this._save(s);
    return { id: s.id };
  }

  async message(id, text, mode) {
    const st = this.live.get(id) || { timers: [], queue: [], streaming: false };
    this.live.set(id, st);
    if (st.streaming) {
      if (mode === "followUp") { st.queue.push(text); this.hub.emit(id, "queue_update", { steering: 0, followUp: st.queue.length }); return; }
      // steer: cut the current stream, answer the steer next.
      this._finishTurn(id, "done", `\n\n(steered)`);
      this._startTurn(id, text, true);
      return;
    }
    this._startTurn(id, text, false);
  }

  async stop(id) {
    const st = this.live.get(id);
    if (!st || !st.streaming) return;
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
    const s = this._load(id);
    const last = s.records[s.records.length - 1];
    if (last && last.role === "assistant" && !last.text) {
      s.records.pop(); // stop during thinking: remove the empty turn entirely
    } else if (last && last.role === "assistant") {
      delete last.streaming;
    }
    this._save(s);
    st.streaming = false;
    st.queue = [];
    this.hub.emit(id, "turn_end", { turnId: st.turnId, reason: "stopped" });
  }

  async bangRecord(id, rec) {
    const s = this._load(id);
    s.records.push(rec);
    this._save(s);
  }

  // ---- scripted turn ----
  _startTurn(id, userText, steered) {
    const st = this.live.get(id);
    const s = this._load(id);
    const userRec = { id: newId("m"), role: "user", text: userText };
    s.records.push(userRec);
    const msgId = newId("m");
    s.records.push({ id: msgId, role: "assistant", text: "", streaming: true });
    this._save(s);

    st.streaming = true;
    st.turnId = newId("t");
    st.msgId = msgId;
    this.hub.emit(id, "user_record", { record: userRec });
    this.hub.emit(id, "turn_start", { turnId: st.turnId });
    this.hub.emit(id, "message_start", { messageId: msgId, role: "assistant" });

    const wantsDiff = /edit|diff|fix|change/i.test(userText);
    const wantsTool = /read|grep|look|file|edit|diff|fix/i.test(userText) || wantsDiff;
    const full = steered
      ? `Steering acknowledged — switching to: ${userText}`
      : `mock: I'd run that against ${path.basename(s.cwd)} — reading first, then proposing an edit. (${userText.slice(0, 60)})`;

    const t0 = setTimeout(() => {
      if (wantsTool) this._emitTool(id, s.cwd, wantsDiff);
      let i = 0;
      const tick = () => {
        if (!st.streaming || st.msgId !== msgId) return;
        i += 3;
        const chunk = full.slice(0, i);
        const cur = this._load(id);
        const rec = cur.records.find(r => r.id === msgId);
        if (!rec) return;
        const delta = chunk.slice(rec.text.length);
        rec.text = chunk;
        if (i >= full.length) delete rec.streaming;
        this._save(cur);
        if (delta) this.hub.emit(id, "text_delta", { messageId: msgId, delta });
        if (i >= full.length) this._finishTurn(id, "done");
        else st.timers.push(setTimeout(tick, DELTA_MS()));
      };
      tick();
    }, THINK_MS());
    st.timers.push(t0);
  }

  _emitTool(id, cwd, withDiff) {
    const toolId = newId("tc");
    const toolRec = {
      id: toolId, role: "tool", tool: "grep",
      arg: `"sessions list" ${path.basename(cwd)}/src`, meta: "3 matches · 0.2s",
      out: "src/commands/sessions.ts:42  export async function sessionsList(\nsrc/cli.ts:130  .command(\"sessions list\")",
    };
    const s = this._load(id);
    // tool/diff records precede the assistant message record in the transcript
    const ai = s.records.findIndex(r => r.id === this.live.get(id).msgId);
    s.records.splice(ai, 0, toolRec);
    this.hub.emit(id, "tool_start", { toolId, name: toolRec.tool, argsSummary: toolRec.arg });
    this.hub.emit(id, "tool_end", { toolId, ok: true, output: toolRec.out, meta: "3 matches", durationMs: 200 });
    if (withDiff) {
      const diffId = newId("df");
      const diffRec = {
        id: diffId, role: "diff", file: "src/commands/sessions.ts", add: "+3", del: "−1",
        lines: [
          { sign: "", text: "@@ -40,4 +40,6 @@" },
          { sign: " ", text: "export async function sessionsList(opts) {" },
          { sign: "-", text: "  console.log(rows);" },
          { sign: "+", text: "  if (opts.json) return printJson(rows);" },
          { sign: "+", text: "  console.table(rows);" },
        ],
      };
      s.records.splice(ai + 1, 0, diffRec);
      this.hub.emit(id, "diff", {
        toolId: diffId, path: diffRec.file, adds: 3, dels: 1,
        hunks: [{ header: "@@ -40,4 +40,6 @@", lines: diffRec.lines.slice(1) }],
      });
    }
    this._save(s);
  }

  _finishTurn(id, reason, suffix = "") {
    const st = this.live.get(id);
    if (!st) return;
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
    if (suffix) {
      const s = this._load(id);
      const rec = s.records.find(r => r.id === st.msgId);
      if (rec) { rec.text += suffix; delete rec.streaming; this._save(s); }
    } else {
      const s = this._load(id);
      const rec = s.records.find(r => r.id === st.msgId);
      if (rec) { delete rec.streaming; this._save(s); }
    }
    st.streaming = false;
    this.hub.emit(id, "message_end", { messageId: st.msgId });
    this.hub.emit(id, "turn_end", { turnId: st.turnId, reason });
    const next = st.queue.shift();
    if (next !== undefined) this._startTurn(id, next, false);
  }
}
