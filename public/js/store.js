// One flat state object + subscribers, mirroring the design handoff's State
// section. Transcripts are cached per session and fed by SSE.
export const CONTRACT_VERSION = 1;

function* iterateSessions(nodes = []) {
  for (const node of nodes) {
    yield node;
    yield* iterateSessions(node.children || []);
  }
}

function timeValue(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareActivity(a, b, field = "updatedAt") {
  return (timeValue(b[field] || b.activityAt) - timeValue(a[field] || a.activityAt))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function sortSessionNodes(nodes, topLevel = true) {
  for (const node of nodes || []) sortSessionNodes(node.children || [], false);
  return (nodes || []).sort((a, b) => compareActivity(a, b, topLevel ? "activityAt" : "updatedAt"));
}

function findSessionPath(nodes, id, path = []) {
  for (const node of nodes || []) {
    const next = [...path, node];
    if (node.id === id) return next;
    const hit = findSessionPath(node.children, id, next);
    if (hit) return hit;
  }
  return null;
}

export const store = {
  state: {
    view: "chat",            // chat | projects | settings
    projectId: null,
    sessionId: null,
    chatId: null,            // non-null => plain chat (no branch chip/files/fork)
    railOpen: true,
    drawerOpen: false,
    openTree: {},
    openTools: {},
    openDirs: {},
    branchMenuOpen: false,
    branchError: null,
    confirm: null,          // { type: "merge"|"close"|"bind", id, branch, error? }
    filesOpen: false,
    repoPickerOpen: false,
    repoPickerSource: null,
    query: "",
    repoQuery: "",
    newBranch: "",
    draft: "",
    model: null,             // active session model reference
    defaultModel: null,      // configured setting; null means Automatic
    effectiveDefaultModel: null,
    defaultModelStatus: "automatic",
    modelError: null,
    models: [],              // registry-backed { id, provider, label }
    animIdx: 0,
    error: null,             // transient composer/action error
    fatalError: null,        // unrecoverable wire-contract error
    fileError: null,
    // server data
    projects: [],
    chats: [],
    mode: "real",
    providers: [],
    repositorySources: null,
    settings: null,
    repos: [],
    reposRoot: null,     // configured directory scanned by /api/repos
    reposRootSource: "default", // default | config | environment
    files: [],
    queued: {},              // sessionId -> follow-up count (queue_update)
    transcripts: {},         // sessionId -> { records, streaming, seq }
  },
  listeners: new Set(),
  set(patch) {
    Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
    this.notify("state");
  },
  notify(what) {
    for (const fn of this.listeners) fn(what);
  },
  setError(message, ms = 5000) {
    const token = Symbol("error");
    this._errorToken = token;
    this.set({ error: message });
    if (ms > 0) setTimeout(() => {
      if (this._errorToken === token) this.set({ error: null });
    }, ms);
  },
  touchSession(id, at = Date.now()) {
    const stamp = new Date(at).toISOString();
    for (const project of this.state.projects) {
      const path = findSessionPath(project.sessions, id);
      if (!path) continue;
      const target = path.at(-1);
      target.updatedAt = stamp;
      target.when = "now";
      for (const node of path) node.activityAt = stamp;
      sortSessionNodes(project.sessions);
      this.notify("state");
      return;
    }
    const chat = this.state.chats.find(item => item.id === id);
    if (chat) {
      chat.updatedAt = stamp;
      chat.activityAt = stamp;
      chat.when = "now";
      this.state.chats.sort((a, b) => compareActivity(a, b));
      this.notify("state");
    }
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  activeKey() {
    return this.state.chatId || this.state.sessionId;
  },
  transcript(id = this.activeKey()) {
    return this.state.transcripts[id] || { records: [], streaming: false };
  },
  project() {
    return this.state.projects.find(p => p.id === this.state.projectId) || null;
  },
  findSession(id, nodes) {
    nodes = nodes || (this.project()?.sessions ?? []);
    for (const n of nodes) {
      if (n.id === id) return n;
      const r = this.findSession(id, n.children);
      if (r) return r;
    }
    return null;
  },
  findAnySession(id) {
    for (const project of this.state.projects) {
      const node = this.findSession(id, project.sessions);
      if (node) return node;
    }
    return this.state.chats.find(chat => chat.id === id) || null;
  },
  workspaceBusy(id) {
    const me = this.findAnySession(id);
    const workspacePath = me?.workspacePath;
    if (!workspacePath) return null;
    for (const project of this.state.projects) {
      for (const node of iterateSessions(project.sessions)) {
        if (node.id !== id && node.workspacePath === workspacePath && this.transcript(node.id).streaming) {
          return { id: node.id, title: node.title };
        }
      }
    }
    return null;
  },
  inProject() {
    return this.state.view === "chat" && !this.state.chatId && !!this.state.sessionId;
  },
};

setInterval(() => { store.state.animIdx++; store.notify("anim"); }, 4600);
