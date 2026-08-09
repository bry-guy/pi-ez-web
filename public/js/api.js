import { CONTRACT_VERSION, store } from "./store.js";

const j = (r) => { if (!r.ok) return r.json().then(b => { throw Object.assign(new Error(b.error || r.status), b); }); return r.json(); };
export const api = {
  state: () => fetch("/api/state").then(j),
  newChat: () => fetch("/api/chats", { method: "POST" }).then(j),
  newProject: (repoPath) => fetch("/api/projects", { method: "POST", headers: JH, body: JSON.stringify({ repoPath }) }).then(j),
  repos: () => fetch("/api/repos").then(j),
  files: (projectId, branch) => fetch(`/api/projects/${projectId}/files${branch ? "?branch=" + encodeURIComponent(branch) : ""}`).then(j),
  transcript: (id) => fetch(`/api/sessions/${id}/transcript`).then(j),
  message: (id, text, mode = "prompt") => fetch(`/api/sessions/${id}/message`, { method: "POST", headers: JH, body: JSON.stringify({ text, mode }) }).then(j),
  stop: (id) => fetch(`/api/sessions/${id}/stop`, { method: "POST" }).then(j),
  bang: (id, cmd) => fetch(`/api/sessions/${id}/bang`, { method: "POST", headers: JH, body: JSON.stringify({ cmd }) }).then(j),
  fork: (id, atRecordId) => fetch(`/api/sessions/${id}/fork`, { method: "POST", headers: JH, body: JSON.stringify({ atRecordId }) }).then(j),
  branch: (id, branch, create = false) => fetch(`/api/sessions/${id}/branch`, { method: "POST", headers: JH, body: JSON.stringify({ branch, create }) }).then(j),
  setModel: (id, model) => fetch(`/api/sessions/${id}/model`, { method: "POST", headers: JH, body: JSON.stringify({ model }) }).then(j),
  close: (id) => fetch(`/api/sessions/${id}/close`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  merge: (id) => fetch(`/api/sessions/${id}/merge`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
};
const JH = { "content-type": "application/json" };

export async function refreshState() {
  const s = await api.state();
  store.set({ projects: s.projects, chats: s.chats, mode: s.mode, model: store.state.model || s.defaultModel || "default" });
}

// --- transcript loading: subscribe first (SSE is global), buffer, snapshot, apply ---
const loading = new Set();
export async function openTranscript(id) {
  if (!id || loading.has(id)) return;
  loading.add(id);
  buffers.set(id, []);
  try {
    const snap = await api.transcript(id);
    store.state.transcripts[id] = { records: snap.records, streaming: snap.streaming };
    for (const evt of buffers.get(id) || []) applyEvent(evt, true);
  } finally {
    buffers.delete(id);
    loading.delete(id);
    store.notify("transcript");
  }
}

// --- SSE ---
const buffers = new Map();
let es = null;
export function connectSSE() {
  if (es) es.close();
  es = new EventSource("/api/events");
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    if (evt.v !== CONTRACT_VERSION) { console.warn("contract version mismatch — reload"); return; }
    const buf = buffers.get(evt.sessionId);
    if (buf) { buf.push(evt); return; } // snapshot in flight; replay after
    applyEvent(evt);
  };
  es.onerror = () => {
    // EventSource auto-reconnects; on reopen, refetch the active transcript so
    // any missed mid-turn deltas are recovered from the snapshot.
    const id = store.activeKey();
    if (id) setTimeout(() => openTranscript(id), 300);
  };
}

function tOf(id) {
  return (store.state.transcripts[id] ||= { records: [], streaming: false });
}

export function applyEvent(evt, replay = false) {
  const t = tOf(evt.sessionId);
  const recs = t.records;
  const byId = rid => recs.find(r => r.id === rid);
  switch (evt.type) {
    case "turn_start": {
      t.streaming = true;
      if (evt.userRecord && !byId(evt.userRecord.id)) recs.push(evt.userRecord);
      break;
    }
    case "message_start": {
      if (!byId(evt.messageId)) recs.push({ id: evt.messageId, role: "assistant", text: "", streaming: true });
      break;
    }
    case "text_delta": {
      let r = byId(evt.messageId);
      if (!r) { r = { id: evt.messageId, role: "assistant", text: "", streaming: true }; recs.push(r); }
      if (!replay || !r.text.endsWith(evt.delta)) r.text += evt.delta; // dedupe on replay
      r.streaming = true;
      break;
    }
    case "message_end": {
      const r = byId(evt.messageId);
      if (r) delete r.streaming;
      break;
    }
    case "tool_start": {
      if (!byId(evt.toolId)) {
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, { id: evt.toolId, role: "tool", tool: evt.name, arg: evt.argsSummary || "", meta: "", out: "" });
      }
      break;
    }
    case "tool_end": {
      const r = byId(evt.toolId);
      if (r) {
        r.out = evt.output || "";
        r.meta = [evt.meta, evt.durationMs != null ? (evt.durationMs / 1000).toFixed(1) + "s" : ""].filter(Boolean).join(" · ");
      }
      break;
    }
    case "diff": {
      if (!byId(evt.toolId + ":d")) {
        const lines = [];
        for (const h of evt.hunks || []) {
          if (h.header) lines.push({ sign: "", text: h.header });
          for (const l of h.lines || []) lines.push(l);
        }
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, {
          id: evt.toolId + ":d", role: "diff", file: evt.path,
          add: "+" + evt.adds, del: "\u2212" + evt.dels, lines,
        });
      }
      break;
    }
    case "bang_start": {
      if (!byId(evt.bangId)) recs.push({ id: evt.bangId, role: "bang", cmd: evt.cmd, meta: "…", out: "" });
      break;
    }
    case "bang_end": {
      const r = byId(evt.bangId);
      if (r) { r.out = evt.stdout || ""; r.meta = `exit ${evt.exit} · ${(evt.durationMs / 1000).toFixed(1)}s`; }
      break;
    }
    case "turn_end": {
      t.streaming = false;
      const last = recs[recs.length - 1];
      if (evt.reason === "stopped" && last && last.role === "assistant" && !last.text) {
        recs.pop(); // stop during thinking removes the empty turn entirely
      } else if (last?.streaming) {
        delete last.streaming;
      }
      if (evt.reason === "errored" && evt.error) {
        recs.push({ id: "err" + evt.seq, role: "assistant", text: "⚠ " + evt.error });
      }
      break;
    }
    case "workspace_busy": {
      store.state.busy[evt.sessionId] = evt.bySessionId;
      break;
    }
    case "session_created":
    case "session_forked":
    case "session_meta": {
      refreshState();
      break;
    }
    case "session_merged": {
      refreshState();
      break;
    }
    case "session_closed":
    case "branch_reaped": {
      const wasChat = store.state.chatId === evt.sessionId;
      const wasSession = store.state.sessionId === evt.sessionId;
      refreshState().then(() => {
        const s = store.state;
        if (wasChat) {
          // closed the open chat -> empty chat view (per design)
          store.set({ chatId: null, branchMenuOpen: false });
          return;
        }
        if (!wasSession) return;
        // closed the open project session -> first session in the SAME project,
        // else most recent chat, else empty (per design)
        const p = s.projects.find(x => x.id === s.projectId);
        if (p?.sessions[0]) {
          store.set({ sessionId: p.sessions[0].id, chatId: null, branchMenuOpen: false });
          openTranscript(p.sessions[0].id);
        } else if (s.chats[0]) {
          store.set({ view: "chat", chatId: s.chats[0].id, sessionId: null, projectId: null, branchMenuOpen: false });
          openTranscript(s.chats[0].id);
        } else {
          store.set({ sessionId: null, chatId: null, branchMenuOpen: false });
        }
      });
      break;
    }
    default: break;
  }
  store.notify(evt.type === "text_delta" ? "delta:" + evt.sessionId : "transcript");
}

function lastStreamingIndex(recs) {
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i].role === "assistant" && recs[i].streaming) return i;
  }
  return recs.length;
}
