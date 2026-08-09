import { CONTRACT_VERSION, store } from "./store.js";

const JH = { "content-type": "application/json" };
const j = (r) => {
  if (!r.ok) return r.json().then(b => { throw Object.assign(new Error(b.error || r.status), b); });
  return r.json();
};

export const api = {
  state: () => fetch("/api/state").then(j),
  models: () => fetch("/api/models").then(j),
  newChat: () => fetch("/api/chats", { method: "POST" }).then(j),
  newProject: (repoPath) => fetch("/api/projects", { method: "POST", headers: JH, body: JSON.stringify({ repoPath }) }).then(j),
  repos: () => fetch("/api/repos").then(j),
  files: (projectId, branch) => fetch(`/api/projects/${projectId}/files${branch ? "?branch=" + encodeURIComponent(branch) : ""}`).then(j),
  transcript: (id) => fetch(`/api/sessions/${id}/transcript`).then(j),
  meta: (id) => fetch(`/api/sessions/${id}/meta`).then(j),
  message: (id, text, mode = "prompt") => fetch(`/api/sessions/${id}/message`, { method: "POST", headers: JH, body: JSON.stringify({ text, mode }) }).then(j),
  stop: (id) => fetch(`/api/sessions/${id}/stop`, { method: "POST" }).then(j),
  bang: (id, cmd) => fetch(`/api/sessions/${id}/bang`, { method: "POST", headers: JH, body: JSON.stringify({ cmd }) }).then(j),
  fork: (id, atRecordId) => fetch(`/api/sessions/${id}/fork`, { method: "POST", headers: JH, body: JSON.stringify({ atRecordId }) }).then(j),
  branch: (id, branch, create = false) => fetch(`/api/sessions/${id}/branch`, { method: "POST", headers: JH, body: JSON.stringify({ branch, create }) }).then(j),
  setModel: (id, model) => fetch(`/api/sessions/${id}/model`, { method: "POST", headers: JH, body: JSON.stringify({ model }) }).then(j),
  settings: (defaultModel) => fetch("/api/settings", { method: "POST", headers: JH, body: JSON.stringify({ defaultModel }) }).then(j),
  close: (id) => fetch(`/api/sessions/${id}/close`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  merge: (id) => fetch(`/api/sessions/${id}/merge`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
};

export async function refreshState() {
  const s = await api.state();
  const active = findSessionInState(s, store.activeKey());
  store.set({
    projects: s.projects,
    chats: s.chats,
    mode: s.mode,
    defaultModel: s.defaultModel || null,
    models: s.models || [],
    model: active?.model || s.defaultModel || null,
  });
}

function findSessionInState(state, id) {
  if (!id) return null;
  for (const p of state.projects || []) {
    const hit = findNode(p.sessions, id);
    if (hit) return hit;
  }
  return (state.chats || []).find(c => c.id === id) || null;
}
function findNode(nodes, id) {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

// --- transcript loading: subscribe first, buffer, snapshot, apply ---
const loading = new Set();
const buffers = new Map();
export async function openTranscript(id) {
  if (!id || loading.has(id)) return;
  loading.add(id);
  buffers.set(id, []);
  try {
    const snap = await api.transcript(id);
    store.state.transcripts[id] = {
      records: snap.records || [],
      streaming: !!snap.streaming,
      seq: snap.seq ?? -1,
    };
    const snapshotSeq = snap.seq ?? -1;
    for (const evt of buffers.get(id) || []) {
      if (evt.seq > snapshotSeq) applyEvent(evt, true);
    }
  } catch (err) {
    store.setError(`Could not load transcript: ${err.error || err.message || err}`);
  } finally {
    buffers.delete(id);
    loading.delete(id);
    store.notify("transcript");
  }
}

// --- SSE ---
let es = null;
export function connectSSE() {
  if (es) es.close();
  es = new EventSource("/api/events");
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    if (evt.v !== CONTRACT_VERSION) {
      store.set({ fatalError: "This server sent an incompatible event contract. Reload the page." });
      return;
    }
    const buf = buffers.get(evt.sessionId);
    if (buf) { buf.push(evt); return; }
    applyEvent(evt);
  };
  es.onerror = () => {
    // Enter the buffer-before-fetch path immediately; EventSource will
    // reconnect itself, and the snapshot seq filters already-applied events.
    const id = store.activeKey();
    if (id) void openTranscript(id);
  };
}

function tOf(id) {
  return (store.state.transcripts[id] ||= { records: [], streaming: false, seq: -1 });
}
function byId(records, id) { return records.find(r => r.id === id); }

export function applyEvent(evt, replay = false) {
  const t = tOf(evt.sessionId);
  const recs = t.records;
  switch (evt.type) {
    case "user_record": {
      const record = evt.record;
      if (record && !byId(recs, record.id)) recs.push(record);
      updateFirstTitle(evt.sessionId, record?.text);
      break;
    }
    case "turn_start":
      t.streaming = true;
      break;
    case "message_start":
      if (!byId(recs, evt.messageId)) recs.push({ id: evt.messageId, role: "assistant", text: "", streaming: true });
      break;
    case "text_delta": {
      let r = byId(recs, evt.messageId);
      if (!r) {
        r = { id: evt.messageId, role: "assistant", text: "", streaming: true };
        recs.push(r);
      }
      // The snapshot sequence barrier makes replay ordering explicit; do not
      // infer identity from text suffixes (repeated tokens are legitimate).
      r.text += evt.delta;
      r.streaming = true;
      break;
    }
    case "message_end": {
      const r = byId(recs, evt.messageId);
      if (r) delete r.streaming;
      break;
    }
    case "tool_start":
      if (!byId(recs, evt.toolId)) {
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, { id: evt.toolId, role: "tool", tool: evt.name, arg: evt.argsSummary || "", meta: "", out: "" });
      }
      break;
    case "tool_end": {
      const r = byId(recs, evt.toolId);
      if (r) {
        r.out = evt.output || "";
        r.meta = [evt.meta, evt.durationMs != null ? (evt.durationMs / 1000).toFixed(1) + "s" : ""].filter(Boolean).join(" · ");
      }
      break;
    }
    case "diff":
      if (!byId(recs, evt.toolId + ":d")) {
        const lines = [];
        for (const h of evt.hunks || []) {
          if (h.header) lines.push({ sign: "", text: h.header });
          for (const l of h.lines || []) lines.push(l);
        }
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, { id: evt.toolId + ":d", role: "diff", file: evt.path, add: "+" + evt.adds, del: "−" + evt.dels, lines });
      }
      break;
    case "bang_start":
      if (!byId(recs, evt.bangId)) recs.push({ id: evt.bangId, role: "bang", cmd: evt.cmd, meta: "…", out: "" });
      break;
    case "bang_end": {
      const r = byId(recs, evt.bangId);
      if (r) { r.out = evt.stdout || ""; r.meta = `exit ${evt.exit} · ${(evt.durationMs / 1000).toFixed(1)}s`; }
      break;
    }
    case "turn_end": {
      t.streaming = false;
      if (evt.reason === "stopped") {
        const empty = [...recs].reverse().find(r => r.role === "assistant" && r.streaming && !r.text);
        if (empty) recs.splice(recs.indexOf(empty), 1);
      }
      for (const r of recs) if (r.role === "assistant" && r.streaming) delete r.streaming;
      if (evt.reason === "errored" && evt.error) recs.push({ id: "err" + evt.seq, role: "assistant", text: "⚠ " + evt.error });
      for (const [sessionId, owner] of Object.entries(store.state.busy)) {
        if (owner === evt.sessionId) delete store.state.busy[sessionId];
      }
      break;
    }
    case "workspace_busy":
      store.state.busy[evt.sessionId] = evt.bySessionId;
      break;
    case "session_created":
    case "session_forked":
    case "session_meta":
    case "session_merged":
      refreshState().catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
      break;
    case "session_closed":
    case "branch_reaped": {
      const wasChat = store.state.chatId === evt.sessionId;
      const wasSession = store.state.sessionId === evt.sessionId;
      refreshState().then(() => {
        const s = store.state;
        if (wasChat) {
          store.set({ chatId: null, branchMenuOpen: false });
          return;
        }
        if (!wasSession) return;
        const p = s.projects.find(x => x.id === s.projectId);
        if (p?.sessions[0]) {
          store.set({ view: "chat", projectId: p.id, sessionId: p.sessions[0].id, chatId: null, branchMenuOpen: false, files: [], fileError: null, model: p.sessions[0].model || s.defaultModel || null });
          openTranscript(p.sessions[0].id);
        } else if (s.chats[0]) {
          store.set({ view: "chat", chatId: s.chats[0].id, sessionId: null, projectId: null, branchMenuOpen: false, filesOpen: false });
          openTranscript(s.chats[0].id);
        } else {
          store.set({ sessionId: null, chatId: null, branchMenuOpen: false, filesOpen: false });
        }
      }).catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
      break;
    }
    default: break;
  }
  store.notify(evt.type === "text_delta" ? "delta:" + evt.sessionId : "transcript");
}

function updateFirstTitle(id, text) {
  if (!text) return;
  for (const p of store.state.projects) {
    const node = findNode(p.sessions, id);
    if (node && node.title === "New session") {
      node.title = text.slice(0, 48);
      store.notify("state");
      return;
    }
  }
  const chat = store.state.chats.find(c => c.id === id);
  if (chat && chat.title === "New session") {
    chat.title = text.slice(0, 48);
    store.notify("state");
  }
}

function lastStreamingIndex(recs) {
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i].role === "assistant" && recs[i].streaming) return i;
  }
  return recs.length;
}
