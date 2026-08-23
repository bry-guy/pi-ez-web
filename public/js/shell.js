import { api, openTranscript, refreshState } from "./api.js";
import { store } from "./store.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const mobile = () => matchMedia("(max-width: 760px)").matches;
const ACTIVE_SESSION_STORAGE_KEY = "pi-ez-web:active-session";
function saveActiveSession(value) {
  try { globalThis.localStorage?.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(value)); } catch { /* storage is optional */ }
}
function savedActiveSession() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(ACTIVE_SESSION_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}
const icon = name => {
  const paths = {
    settings: '<path d="M9.7 1.5h.6l.7 1.9 1.5.9 2-.5.4.4.3.5-.9 1.8.1 1.7 1.5 1.4-.2.6-.2.5-2 .1-1.2 1.2-.1 2-.5.2-.6.2-1.4-1.5-1.7-.1-1.8.9-.5-.3-.4-.4.5-2-1-1.5-1.8-.7v-.6-.6l1.8-.7 1-1.5-.5-2 .5-.4.4-.3 1.8.9 1.7-.1 1.4-1.5Z"/><circle cx="10" cy="10" r="2.2"/>',
    chevronLeft: '<path d="m12.5 4-6 6 6 6"/>',
    chevronRight: '<path d="m7.5 4 6 6-6 6"/>',
  };
  return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
};

export function openSessionPicker(projectId, { mode = "new", sourceSessionId = null, branch = null, name = null } = {}) {
  const project = store.state.projects.find(p => p.id === projectId);
  if (!project) return;
  const source = sourceSessionId || (mode !== "new" ? store.state.sessionId : null);
  const active = source ? store.findSession(source, project.sessions) : null;
  const defaultBranch = project.defaultBranch || project.primaryBranch || "main";
  const currentBranch = active ? (active.branch || defaultBranch) : (project.branch || defaultBranch);
  store.set({
    sessionPicker: {
      projectId,
      mode: ["switch", "fork"].includes(mode) ? mode : "new",
      sourceSessionId: source,
      branch: branch || (mode === "new" ? defaultBranch : currentBranch),
      baseBranch: defaultBranch,
      name: name ?? (mode === "new" ? "" : active?.name || active?.title || ""),
      branchMenuOpen: false,
      currentBranch,
    },
    sessionPickerError: null,
    drawerOpen: false,
  });
}

export function selectSession(projectId, sessionId) {
  const project = store.state.projects.find(p => p.id === projectId);
  const node = findNode(project?.sessions, sessionId);
  store.set({
    view: "chat", projectId, sessionId, chatId: null, drawerOpen: false, sessionPicker: null, sessionPickerError: null,
    filesOpen: store.state.filesOpen, files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "none", fileTargets: ["none", "HEAD"], fileLoading: false, filesLoadedKey: null, hookResult: null,
    workspaceSettingsOpen: false, model: node?.model || store.state.effectiveDefaultModel || null,
  });
  saveActiveSession({ kind: "session", projectId, id: sessionId });
  store.markRead(sessionId);
  openTranscript(sessionId);
}
export function selectChat(chatId) {
  const chat = store.state.chats.find(c => c.id === chatId);
  store.set({
    view: "chat", chatId, sessionId: null, projectId: null, drawerOpen: false, sessionPicker: null, sessionPickerError: null,
    workspaceSettingsOpen: false, filesOpen: false, files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "none", fileTargets: ["none", "HEAD"], fileLoading: false, filesLoadedKey: null, hookResult: null,
    model: chat?.model || store.state.effectiveDefaultModel || null,
  });
  saveActiveSession({ kind: "chat", id: chatId });
  store.markRead(chatId);
  openTranscript(chatId);
}

export function restoreLastSelection() {
  const saved = savedActiveSession();
  if (!saved?.id) return false;
  if (saved.kind === "chat" && store.state.chats.some(chat => chat.id === saved.id)) {
    selectChat(saved.id);
    return true;
  }
  if (saved.kind === "session") {
    const project = store.state.projects.find(candidate => candidate.id === saved.projectId && findNode(candidate.sessions, saved.id));
    if (project) {
      store.state.openTree[project.id] = true;
      selectSession(project.id, saved.id);
      return true;
    }
  }
  return false;
}
export async function newChat() {
  const { id } = await api.newChat();
  // Select immediately: real `/api/state` discovery can be slow, and waiting
  // here leaves the previous chat active long enough for a prompt to land in
  // the wrong transcript.
  selectChat(id);
  await refreshState();
}

export async function newProjectSession(projectId) {
  openSessionPicker(projectId, { mode: "new" });
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}
function fuzzyMatch(value, query) {
  if (!query) return true;
  let i = 0;
  const text = String(value || "").toLowerCase();
  for (const char of query.toLowerCase()) {
    i = text.indexOf(char, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}
function nodeMatches(n, q) {
  if (!q) return true;
  return fuzzyMatch(n.title, q) || (n.children || []).some(child => nodeMatches(child, q));
}

/* ---------------- sidebar ---------------- */
class PiSidebar extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => this.onKeyDown(e));
    this.addEventListener("input", e => {
      if (e.target.matches(".rail-search")) {
        store.state.query = e.target.value;
        this.renderResults();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  onKeyDown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target.closest("[data-act]");
    if (!target || target.matches("button,input")) return;
    e.preventDefault();
    target.click();
  }

  onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "close-row") {
      e.stopPropagation();
      const project = t.dataset.pid ? store.state.projects.find(item => item.id === t.dataset.pid) : null;
      const branch = t.dataset.branch || "";
      store.set({ confirm: { type: "close", kind: t.dataset.kind, id: t.dataset.id, label: t.dataset.label, branch, externalMain: !!project?.workspaceStatus?.[branch]?.externalMain } });
      return;
    }
    if (act === "collapse") {
      e.preventDefault();
      e.stopPropagation();
      store.set(mobile() ? { drawerOpen: false } : { railOpen: !store.state.railOpen });
    }
    else if (act === "search") {
      e.preventDefault();
      e.stopPropagation();
      store.set({ railOpen: true });
      requestAnimationFrame(() => this.querySelector(".rail-search")?.focus());
    }
    else if (act === "new-chat") newChat().catch(err => store.setError(`Could not create chat: ${err.message || err}`));
    else if (act === "new-project-session") {
      e.stopPropagation();
      newProjectSession(t.dataset.id).catch(err => store.setError(`Could not create session: ${err.error || err.message || err}`));
    } else if (act === "repo-picker") store.set({ repoPickerOpen: true, drawerOpen: false });
    else if (act === "settings") store.set({ view: "settings", drawerOpen: false });
    else if (act === "toggle-tree") {
      e.stopPropagation();
      const id = t.dataset.treeId;
      if (!id) return;
      store.state.openTree[id] = !store.state.openTree[id];
      store.notify("state");
    } else if (act === "project-row") {
      const p = store.state.projects.find(x => x.id === t.dataset.id);
      if (!p) return;
      const first = p.sessions[0];
      if (first) selectSession(p.id, first.id);
      else store.set({ view: "chat", projectId: p.id, sessionId: null, chatId: null, filesOpen: false });
    } else if (act === "session-row") {
      selectSession(t.dataset.pid, t.dataset.id);
    } else if (act === "chat-row") selectChat(t.dataset.id);
  }

  count(nodes) { return nodes.reduce((n, x) => n + 1 + this.count(x.children), 0); }

  sessionRows(p, nodes, depth, q, out, forceAll = false) {
    for (const n of nodes) {
      const direct = !q || fuzzyMatch(n.title, q);
      const descendant = q && (n.children || []).some(child => nodeMatches(child, q));
      if (q && !forceAll && !direct && !descendant) continue;
      const kids = n.children.length > 0;
      const open = !!store.state.openTree[n.id];
      const sel = store.state.sessionId === n.id && !store.state.chatId && store.state.view === "chat";
      const streaming = store.transcript(n.id).streaming;
      const unread = !!store.state.unread[n.id];
      out.push(`<div class="row-wrap nested" style="margin-left:${13 + depth * 13}px">
        <div class="row ${sel ? "active " : ""}${streaming ? "streaming " : ""}${unread ? "unread" : ""}" role="button" tabindex="0" ${kids ? `aria-expanded="${open || !!q}"` : ""} data-act="session-row" data-id="${esc(n.id)}" data-pid="${esc(p.id)}" data-kids="${kids ? 1 : 0}">
          <span class="caret" ${kids ? `data-act="toggle-tree" data-tree-id="${esc(n.id)}" role="button" tabindex="0" aria-label="${open ? "Collapse" : "Expand"} ${esc(n.title)}"` : ""}>${kids ? ((open || q) ? "▾" : "▸") : "·"}</span>
          <span class="lbl">${esc(n.title)}</span>
          <span class="live-dot" aria-label="${unread ? "Unread reply" : "Streaming"}"></span>
          <button class="row-close" data-act="close-row" data-kind="session" data-pid="${esc(p.id)}" data-id="${esc(n.id)}"
            data-label="${esc(n.title)}" data-branch="${esc(n.branch || "")}" title="Close session">×</button>
        </div></div>`);
      if (kids && (open || q || forceAll)) this.sessionRows(p, n.children, depth + 1, forceAll ? "" : q, out, forceAll);
    }
  }

  render() {
    const s = store.state;
    const isMobile = mobile();
    const expanded = isMobile ? s.drawerOpen : s.railOpen;
    const layout = !expanded && !isMobile ? "mini" : !expanded ? "empty" : "rail";
    if (this.dataset.layout !== layout) {
      this.dataset.layout = layout;
      if (layout === "mini") {
        this.innerHTML = `<aside class="mini">
          <button class="mini-logo" data-act="collapse" title="Expand sidebar">π</button>
          <div class="mini-gap"></div>
          <button class="mini-btn cta-plus" data-act="new-chat" title="New chat">+</button>
          <button class="mini-btn quiet" data-act="search" title="Search sessions" aria-label="Search sessions">⌕</button>
          <div class="mini-flex"></div>
          <button class="mini-btn quiet" data-act="settings" title="Settings">${icon("settings")}</button>
        </aside>`;
        return;
      }
      if (layout === "empty") { this.innerHTML = ""; return; }
      this.innerHTML = `<aside class="rail">
        <div class="rail-head">
          <button class="rail-logo" data-act="collapse" title="Collapse sidebar">π</button><div class="rail-word">pi</div>
        </div>
        <div class="rail-actions">
          <input class="rail-search" placeholder="Filter chats and sessions" aria-label="Filter chats and sessions">
        </div>
        <div class="rail-scroll">
          <div class="sec-head"><div class="sec-label">Projects</div>
            <button class="ghost-btn cta-plus" data-act="repo-picker" title="New project" style="padding:3px 6px">+</button></div>
          <div class="projects-list"></div>
          <div class="sec-head chats-head"><div class="sec-label">Chats</div>
            <button class="ghost-btn cta-plus" data-act="new-chat" title="New chat" style="padding:3px 6px">+</button></div>
          <div class="chats-list"></div>
        </div>
        <div class="rail-foot">
          <div class="avatar">π</div><div class="rail-user">pi-web</div>
          <button class="ghost-btn" data-act="settings" title="Settings" style="font-size:13px">${icon("settings")}</button>
        </div>
      </aside>`;
    }
    if (layout === "rail") {
      const inp = this.querySelector(".rail-search");
      if (inp && inp.value !== s.query && document.activeElement !== inp) inp.value = s.query;
      this.renderResults();
    }
  }

  renderResults() {
    if (this.dataset.layout !== "rail") return;
    const s = store.state;
    const q = s.query.trim().toLowerCase();
    const projRows = [];
    for (const p of s.projects) {
      const nameMatch = !q || fuzzyMatch(p.name, q);
      if (q && !nameMatch && !p.sessions.some(n => nodeMatches(n, q))) continue;
      const open = !!s.openTree[p.id] || !!q;
      const active = s.view === "chat" && s.projectId === p.id && !s.chatId;
      projRows.push(`<div class="row-wrap" style="margin-top:1px">
        <div class="row mono ${active && !open ? "active" : ""}" role="button" tabindex="0" aria-expanded="${open}" data-act="project-row" data-id="${esc(p.id)}">
          <span class="caret" data-act="toggle-tree" data-tree-id="${esc(p.id)}" role="button" tabindex="0" aria-label="${open ? "Collapse" : "Expand"} ${esc(p.name)}">${open ? "▾" : "▸"}</span>
          <span class="lbl">${esc(p.name)}</span>
          <span class="count">${this.count(p.sessions)}</span>
          <button class="row-add cta-plus" data-act="new-project-session" data-id="${esc(p.id)}" title="New session in ${esc(p.name)}" aria-label="New session in ${esc(p.name)}">+</button>
        </div></div>`);
      if (open) this.sessionRows(p, p.sessions, 0, nameMatch ? "" : q, projRows, nameMatch);
    }
    const chatRows = s.chats
      .filter(cRow => !q || fuzzyMatch(cRow.title, q))
      .map(cRow => {
        const streaming = cRow.streaming || store.transcript(cRow.id).streaming;
        const unread = !!s.unread[cRow.id];
        return `<div class="row ${s.chatId === cRow.id ? "active " : ""}${streaming ? "streaming " : ""}${unread ? "unread" : ""}" role="button" tabindex="0" data-act="chat-row" data-id="${esc(cRow.id)}">
        <span class="lbl">${esc(cRow.title)}</span><span class="live-dot" aria-label="${unread ? "Unread reply" : "Streaming"}"></span><span class="when">${esc(cRow.when)}</span>
        <button class="row-close" data-act="close-row" data-kind="chat" data-id="${esc(cRow.id)}"
          data-label="${esc(cRow.title)}" data-branch="" title="Close chat">×</button>
      </div>`;
      }).join("");
    this.querySelector(".projects-list").innerHTML = projRows.join("");
    this.querySelector(".chats-list").innerHTML = chatRows;
  }
}

/* ---------------- header ---------------- */
class PiHeader extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.render(); });
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.workspaceSettingsOpen) {
        e.preventDefault();
        store.set({ workspaceSettingsOpen: false });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.matches("button,input,select")) {
        const t = e.target.closest("[data-act]");
        if (t) { e.preventDefault(); t.click(); }
      }
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }

  async onClick(e) {
    const scrim = this.querySelector(".workspace-scrim");
    if (e.target === scrim) { store.set({ workspaceSettingsOpen: false }); return; }
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "sidebar-toggle") {
      e.preventDefault();
      e.stopPropagation();
      store.set(mobile()
        ? { drawerOpen: !store.state.drawerOpen }
        : { railOpen: !store.state.railOpen });
    } else if (act === "settings") {
      store.set({ view: "settings", workspaceSettingsOpen: false });
    } else if (act === "sync-session") {
      await this.syncSession();
    } else if (act === "workspace-settings") {
      const p = store.project();
      if (p) openSessionPicker(p.id, { mode: "switch", sourceSessionId: store.state.sessionId });
      void refreshState().catch(() => {});
    } else if (act === "close-workspace-settings") {
      store.set({ workspaceSettingsOpen: false });
    } else if (act === "files") {
      this.dispatchEvent(new CustomEvent("toggle-files", { bubbles: true }));
    }
  }

  async syncSession() {
    const id = store.state.chatId || store.state.sessionId;
    if (!id || this.syncBusy) return;
    this.syncBusy = true;
    this.render();
    try {
      await api.syncSession(id);
      await refreshState();
      store.setError("Conversation synchronized.", 2200);
    } catch (err) {
      const messages = {
        sync_not_configured: "Configure a sync server in Settings first.",
        sync_client_unavailable: "The pi-sync client is not installed on this server yet.",
        sync_unavailable: "The synchronization service is temporarily unavailable.",
        sync_duplicate: "This conversation already has a canonical synchronized copy.",
        active_lease: err.details?.holder ? `This conversation is in use by ${err.details.holder}.` : "This conversation is in use by another client.",
        sync_conflict: "The canonical conversation changed elsewhere; the local copy was preserved.",
        sync_lease_uncertain: "The synchronization lease could not be verified. Try again after the service recovers.",
        sync_session_not_found: "The sync server no longer has this conversation.",
        sync_workspace_setup_required: err.message || "Prepare the recorded Git workspace before continuing.",
        session_streaming: "Stop the current response before synchronizing this conversation.",
        session_compacting: "Wait for compaction to finish before synchronizing this conversation.",
      };
      store.setError(messages[err.error] || err.message || err.error || "Could not synchronize this conversation.");
    } finally {
      this.syncBusy = false;
      this.render();
    }
  }

  sessionContext() {
    const p = store.project();
    const node = store.findSession(store.state.sessionId);
    if (!p) return null;
    return p.contexts?.find(context => context.id === node?.contextId)
      || p.contexts?.find(context => context.path === node?.workspacePath)
      || p.contexts?.find(context => context.kind === "checkout")
      || p.contexts?.[0]
      || null;
  }

  sessionBranch() {
    return this.sessionContext()?.branch || null;
  }

  contextLabel(context) {
    if (context?.kind === "unavailable") return "Unavailable context";
    return context?.branch || `detached @ ${(context?.head || "unknown").slice(0, 8)}`;
  }

  render() {
    const s = store.state;
    const p = store.project();
    const inProject = store.inProject() && p;
    const chat = s.chats.find(x => x.id === s.chatId);
    const node = inProject ? store.findSession(s.sessionId) : null;
    const title = s.view === "settings" ? "Settings"
      : chat ? chat.title : node ? node.title : (s.chatId ? "New chat" : (p ? p.name : "Chat"));
    const activeSession = node || chat;
    const activeStreaming = !!activeSession && (activeSession.streaming || store.transcript(activeSession.id).streaming);
    const syncControl = activeSession?.synchronized && activeSession.syncState === "in_use"
      ? `<span class="sync-badge" title="In use by ${esc(activeSession.leaseHolder || "another client")}">IN USE</span>`
      : activeSession?.synchronized && activeSession.syncState !== "error"
        ? `<span class="sync-badge" title="This conversation is synchronized">SYNCED</span>`
        : s.sync?.configured && s.sync.connection === "available" && activeSession && !activeStreaming
          ? `<button class="settings-action sync-header-action" data-act="sync-session" ${this.syncBusy ? "disabled" : ""}>${this.syncBusy ? "Synchronizing…" : "Synchronize this conversation"}</button>`
          : "";
    const workspace = inProject ? this.sessionContext() : null;
    const branch = workspace ? this.contextLabel(workspace) : null;
    const workspaceArea = inProject && workspace ? `
      <div class="bar-sub">
        <button class="workspace-trigger" data-act="workspace-settings" title="Show Git context" aria-label="Show Git context for ${esc(p.name)} ${esc(branch)}">
          <span class="workspace-repo">${esc(p.name)}</span><span class="workspace-divider">·</span>
          <span class="workspace-branch">${esc(branch)}</span>${this.workspaceLabels(workspace)}
        </button>
      </div>` : "";
    const filesBtn = inProject ? `
      <button class="ghost-btn" data-act="files" title="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        style="${s.filesOpen ? "color:var(--text)" : ""}">${icon(s.filesOpen ? "chevronRight" : "chevronLeft")}</button>` : "";
    const sidebarOpen = mobile() ? s.drawerOpen : s.railOpen;
    const sidebarControl = mobile()
      ? `<svg width="17" height="15" viewBox="0 0 17 15" aria-hidden="true"><rect width="17" height="1.8" y="0" fill="currentColor"/><rect width="17" height="1.8" y="6.6" fill="currentColor"/><rect width="17" height="1.8" y="13.2" fill="currentColor"/></svg>`
      : icon(sidebarOpen ? "chevronLeft" : "chevronRight");
    this.innerHTML = `<header class="bar">
      <button class="hamburger" data-act="sidebar-toggle" title="${sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}" aria-expanded="${sidebarOpen}">${sidebarControl}</button>
      <div class="bar-main"><div class="bar-title">${esc(title)}</div>${workspaceArea}</div>
      ${syncControl}${filesBtn}
    </header>`;
  }

  statusBits(status) {
    const cleanliness = status.status === "unavailable" ? "unavailable" : status.status === "unknown" || status.dirty == null ? "unknown" : status.dirty ? "dirty" : "clean";
    return [cleanliness, status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" · ");
  }

  workspaceLabels(status) {
    const kind = status.kind === "checkout" ? "CHECKOUT" : status.kind === "unavailable" ? "UNAVAILABLE" : "WORKTREE";
    const cleanliness = status.status === "unavailable" ? "unavailable" : status.status === "unknown" || status.dirty == null ? "unknown" : status.dirty ? "dirty" : "clean";
    return [kind, cleanliness, status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""]
      .filter(Boolean)
      .map((label, index) => `<span class="workspace-badge ${index === 0 ? "kind" : "state"}">${esc(label)}</span>`)
      .join("");
  }

}

customElements.define("pi-sidebar", PiSidebar);
customElements.define("pi-header", PiHeader);
