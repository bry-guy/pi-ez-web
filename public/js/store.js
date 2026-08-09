// One flat state object + subscribers, mirroring the design handoff's State
// section. Transcripts are cached per session and fed by SSE.
export const CONTRACT_VERSION = 1;

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
    confirm: null,          // { type: "merge"|"close", kind, id, label, branch, error? }
    filesOpen: false,
    repoPickerOpen: false,
    query: "",
    repoQuery: "",
    newBranch: "",
    draft: "",
    model: null,
    animIdx: 0,
    // server data
    projects: [],
    chats: [],
    mode: "real",
    repos: [],
    files: [],
    transcripts: {},         // sessionId -> { records, streaming }
    busy: {},                // sessionId -> bySessionId (workspace_busy)
  },
  listeners: new Set(),
  set(patch) {
    Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
    this.notify("state");
  },
  notify(what) {
    for (const fn of this.listeners) fn(what);
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
  inProject() {
    return this.state.view === "chat" && !this.state.chatId && !!this.state.sessionId;
  },
};

setInterval(() => { store.state.animIdx++; store.notify("anim"); }, 4600);
