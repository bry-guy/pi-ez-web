import { CONTRACT_VERSION, store } from "./store.js";

const API_CONTRACT_VERSION = 2;
const REQUIRED_CAPABILITIES = ["provider-auth", "github-device-auth", "repository-sources", "session-activity", "slash-commands", "project-hooks"];
const JH = { "content-type": "application/json" };
export function formatDuration(durationMs) {
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function validateStateContract(state) {
  const advertised = new Set(Array.isArray(state?.capabilities) ? state.capabilities : []);
  const missing = REQUIRED_CAPABILITIES.filter(capability => !advertised.has(capability));
  if (state?.apiContractVersion === API_CONTRACT_VERSION && missing.length === 0) return state;
  const error = Object.assign(new Error("incompatible_server"), {
    error: "incompatible_server",
    message: "The server is running an older pi-ez-web build. Restart pi-ez-web and reload this page.",
  });
  store.set({ fatalError: error.message });
  throw error;
}

async function responseBody(r) {
  const type = r.headers.get("content-type") || "";
  if (type.includes("application/json")) return r.json().catch(() => ({}));
  const text = await r.text().catch(() => "");
  return text ? { message: text.slice(0, 300) } : {};
}

const j = async (r) => {
  const body = await responseBody(r);
  if (!r.ok) {
    const code = body.error || `http_${r.status}`;
    const message = body.message || (body.requestId ? `${code} (${body.requestId})` : code);
    throw Object.assign(new Error(message), body, {
      status: r.status,
      requestId: body.requestId || r.headers.get("x-request-id"),
    });
  }
  return body;
};

export const api = {
  state: () => fetch("/api/state", { cache: "no-store" }).then(j),
  health: () => fetch(`/api/health?probe=${Date.now()}`, { cache: "no-store" }).then(j),
  models: () => fetch("/api/models").then(j),
  providers: () => fetch("/api/providers").then(j),
  authStart: (providerId, type) => fetch(`/api/providers/${encodeURIComponent(providerId)}/login`, { method: "POST", headers: JH, body: JSON.stringify({ type }) }).then(j),
  authFlow: id => fetch(`/api/auth-flows/${encodeURIComponent(id)}`).then(j),
  authInput: (id, promptId, value) => fetch(`/api/auth-flows/${encodeURIComponent(id)}/input`, { method: "POST", headers: JH, body: JSON.stringify({ promptId, value }) }).then(j),
  authCancel: id => fetch(`/api/auth-flows/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j),
  providerLogout: providerId => fetch(`/api/providers/${encodeURIComponent(providerId)}/logout`, { method: "POST" }).then(j),
  newChat: () => fetch("/api/chats", { method: "POST" }).then(j),
  newProject: value => {
    const body = typeof value === "string" ? { repoPath: value } : (value || {});
    return fetch("/api/projects", { method: "POST", headers: JH, body: JSON.stringify(body) }).then(j);
  },
  newProjectSession: (projectId) => fetch(`/api/projects/${projectId}/sessions`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  repos: () => fetch("/api/repos").then(j),
  repositorySources: () => fetch("/api/repository-sources").then(j),
  githubRepos: (query = "", page = 1) => fetch(`/api/github/repos?q=${encodeURIComponent(query)}&page=${encodeURIComponent(page)}`).then(j),
  githubPublicRepos: (owner, query = "", page = 1) => {
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (owner) params.set("owner", owner);
    return fetch(`/api/github/public-repos?${params}`).then(j);
  },
  githubLogin: () => fetch("/api/github/device-login", { method: "POST" }).then(j),
  githubFlow: id => fetch(`/api/github/device-login/${encodeURIComponent(id)}`).then(j),
  githubCancel: id => fetch(`/api/github/device-login/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j),
  githubLogout: () => fetch("/api/github/logout", { method: "POST" }).then(j),
  files: (projectId, branch) => fetch(`/api/projects/${projectId}/files${branch ? "?branch=" + encodeURIComponent(branch) : ""}`).then(j),
  transcript: (id) => fetch(`/api/sessions/${id}/transcript`).then(j),
  meta: (id) => fetch(`/api/sessions/${id}/meta`).then(j),
  message: (id, text, mode = "prompt", images = []) => fetch(`/api/sessions/${id}/message`, {
    method: "POST", headers: JH, body: JSON.stringify({ text, mode, images }),
  }).then(j),
  stop: (id) => fetch(`/api/sessions/${id}/stop`, { method: "POST" }).then(j),
  bang: (id, cmd) => fetch(`/api/sessions/${id}/bang`, { method: "POST", headers: JH, body: JSON.stringify({ cmd }) }).then(j),
  fork: (id, atRecordId) => fetch(`/api/sessions/${id}/fork`, { method: "POST", headers: JH, body: JSON.stringify({ atRecordId }) }).then(j),
  branch: (id, branch, create = false, fromRef = undefined) => fetch(`/api/sessions/${id}/branch`, { method: "POST", headers: JH, body: JSON.stringify({ branch, create, ...(fromRef ? { fromRef } : {}) }) }).then(j),
  setModel: (id, model) => fetch(`/api/sessions/${id}/model`, { method: "POST", headers: JH, body: JSON.stringify({ model }) }).then(j),
  commands: id => fetch(`/api/sessions/${encodeURIComponent(id)}/commands`).then(j),
  command: (id, text, mode = "prompt") => fetch(`/api/sessions/${encodeURIComponent(id)}/command`, { method: "POST", headers: JH, body: JSON.stringify({ text, mode }) }).then(j),
  hook: (id, name) => fetch(`/api/sessions/${encodeURIComponent(id)}/hooks/${encodeURIComponent(name)}`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  settings: (defaultModel, reposRoot) => {
    const body = {};
    if (defaultModel !== undefined) body.defaultModel = defaultModel;
    if (reposRoot !== undefined) body.reposRoot = reposRoot;
    return fetch("/api/settings", { method: "POST", headers: JH, body: JSON.stringify(body) }).then(j);
  },
  settingsPatch: patch => fetch("/api/settings", { method: "POST", headers: JH, body: JSON.stringify(patch || {}) }).then(j),
  close: (id) => fetch(`/api/sessions/${id}/close`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  merge: (id) => fetch(`/api/sessions/${id}/merge`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
};

export async function refreshState() {
  const s = validateStateContract(await api.state());
  const active = findSessionInState(s, store.activeKey());
  store.set({
    projects: s.projects,
    chats: s.chats,
    mode: s.mode,
    buildId: s.buildId || null,
    reconnecting: false,
    defaultModel: s.defaultModel || null,
    effectiveDefaultModel: s.effectiveDefaultModel || null,
    defaultModelStatus: s.defaultModelStatus || "automatic",
    modelError: s.modelError || null,
    models: s.models || [],
    providers: s.providers || [],
    repositorySources: s.repositorySources || null,
    settings: s.settings || null,
    reposRoot: s.reposRoot || null,
    reposRootSource: s.reposRootSource || "default",
    model: active?.model || s.effectiveDefaultModel || null,
  });
  for (const project of s.projects || []) seedStreaming(project.sessions);
  for (const chat of s.chats || []) {
    const transcript = store.state.transcripts[chat.id] ||= { records: [], streaming: false, seq: -1 };
    transcript.streaming = !!chat.streaming;
  }
  store.notify("transcript");
}

function seedStreaming(nodes) {
  for (const node of nodes || []) {
    const transcript = store.state.transcripts[node.id] ||= { records: [], streaming: false, seq: -1 };
    transcript.streaming = !!node.streaming;
    seedStreaming(node.children);
  }
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchTranscriptWithRetry(id, delays = [300, 900, 2000]) {
  for (let attempt = 0; ; attempt++) {
    try { return await api.transcript(id); }
    catch (err) {
      // Server-side 4xx/5xx carry an `error` code — don't retry those.
      if (err.error || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

export async function openTranscript(id) {
  if (!id || loading.has(id)) return;
  loading.add(id);
  buffers.set(id, []);
  try {
    const snap = await fetchTranscriptWithRetry(id);
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
let recoveryTimer = null;
let recoveryAttempt = 0;
let recoveryInFlight = false;
let reloadIssued = false;

function stopRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recoveryAttempt = 0;
  store.set({ reconnecting: false });
}

function scheduleRecovery(delay) {
  if (recoveryTimer || reloadIssued) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverConnection();
  }, delay);
}

async function recoverConnection() {
  if (reloadIssued || recoveryInFlight) return;
  recoveryInFlight = true;
  try {
    const health = await api.health();
    if (!health?.ok) throw new Error("health check failed");
    if (store.state.buildId && health.buildId && health.buildId !== store.state.buildId) {
      reloadIssued = true;
      location.reload();
      return;
    }
    await refreshState();
    stopRecovery();
  } catch {
    recoveryAttempt += 1;
    const delay = Math.min(10000, 500 * (2 ** Math.min(recoveryAttempt, 4)));
    scheduleRecovery(delay);
  } finally {
    recoveryInFlight = false;
  }
}

function startRecovery() {
  if (recoveryTimer || recoveryInFlight || reloadIssued) return;
  store.set({ reconnecting: true });
  scheduleRecovery(250);
}

export function connectSSE() {
  if (es) es.close();
  es = new EventSource(`/api/events?build=${encodeURIComponent(store.state.buildId || "")}`);
  es.onopen = () => {
    if (!recoveryTimer && !recoveryInFlight) return;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    void recoverConnection();
  };
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
    // EventSource reconnects by itself, while the health poller handles a
    // rollout that replaces this process and eventually reloads on a new build.
    const id = store.activeKey();
    if (id) void openTranscript(id);
    startRecovery();
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
      if (!replay) store.touchSession(evt.sessionId);
      break;
    }
    case "turn_start":
      t.streaming = true;
      break;
    case "queue_update":
      store.state.queued[evt.sessionId] = evt.followUp || 0;
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
        r.meta = [evt.meta, evt.durationMs != null ? formatDuration(evt.durationMs) : ""].filter(Boolean).join(" · ");
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
      if (r) { r.out = evt.stdout || ""; r.meta = `exit ${evt.exit} · ${formatDuration(evt.durationMs)}`; }
      break;
    }
    case "turn_end": {
      t.streaming = false;
      delete store.state.queued[evt.sessionId];
      const lastAssistant = [...recs].reverse().find(record => record.role === "assistant");
      const hasAssistantText = !!lastAssistant?.text;
      if (evt.reason !== "stopped" || hasAssistantText) store.markUnread(evt.sessionId);
      if (evt.reason === "stopped") {
        const empty = [...recs].reverse().find(r => r.role === "assistant" && r.streaming && !r.text);
        if (empty) recs.splice(recs.indexOf(empty), 1);
      }
      for (const r of recs) if (r.role === "assistant" && r.streaming) delete r.streaming;
      if (evt.reason === "errored" && evt.error) recs.push({ id: "err" + evt.seq, role: "assistant", text: "⚠ " + evt.error });
      break;
    }
    case "workspace_busy":
      tOf(evt.bySessionId).streaming = true;
      break;
    case "session_created":
    case "session_forked":
    case "session_meta":
    case "session_merged":
      refreshState().catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
      break;
    case "session_closed": {
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
          store.set({ view: "chat", projectId: p.id, sessionId: p.sessions[0].id, chatId: null, branchMenuOpen: false, files: [], fileError: null, model: p.sessions[0].model || s.effectiveDefaultModel || null });
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
  const title = String(text || "").replace(/\s+/g, " ").trim().slice(0, 48);
  if (!title) return;
  for (const p of store.state.projects) {
    const node = findNode(p.sessions, id);
    if (node && node.title === "New session") {
      node.title = title;
      store.notify("state");
      return;
    }
  }
  const chat = store.state.chats.find(c => c.id === id);
  if (chat && chat.title === "New session") {
    chat.title = title;
    store.notify("state");
  }
}

function lastStreamingIndex(recs) {
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i].role === "assistant" && recs[i].streaming) return i;
  }
  return recs.length;
}
