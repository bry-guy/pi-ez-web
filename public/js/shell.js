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

export function selectSession(projectId, sessionId) {
  const project = store.state.projects.find(p => p.id === projectId);
  const node = findNode(project?.sessions, sessionId);
  store.set({
    view: "chat", projectId, sessionId, chatId: null, drawerOpen: false,
    filesOpen: store.state.filesOpen, files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "none", fileTargets: ["none", "HEAD"], fileLoading: false, filesLoadedKey: null, hookResult: null,
    workspaceSettingsOpen: false, worktreeFormOpen: false, workspaceError: null, model: node?.model || store.state.effectiveDefaultModel || null,
  });
  saveActiveSession({ kind: "session", projectId, id: sessionId });
  store.markRead(sessionId);
  openTranscript(sessionId);
}
export function selectChat(chatId) {
  const chat = store.state.chats.find(c => c.id === chatId);
  store.set({
    view: "chat", chatId, sessionId: null, projectId: null, drawerOpen: false,
    workspaceSettingsOpen: false, worktreeFormOpen: false, workspaceError: null, filesOpen: false, files: [], fileError: null, filePath: null, fileView: null,
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
  const { id } = await api.newProjectSession(projectId);
  await refreshState();
  const project = store.state.projects.find(p => p.id === projectId);
  if (project && !findNode(project.sessions, id)) {
    const now = new Date().toISOString();
    project.sessions.unshift({
      id, title: "New session", branch: project.branch, workspacePath: project.repoPath,
      model: store.state.effectiveDefaultModel, when: "now", updatedAt: now, activityAt: now,
      streaming: false, children: [],
    });
  }
  store.state.openTree[projectId] = true;
  selectSession(projectId, id);
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
      store.set({ confirm: { type: "close", kind: t.dataset.kind, id: t.dataset.id, label: t.dataset.label, branch: t.dataset.branch } });
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
          <button class="row-close" data-act="close-row" data-kind="session" data-id="${esc(n.id)}"
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
        store.set({ workspaceSettingsOpen: false, worktreeFormOpen: false, workspaceError: null });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if (e.target.matches(".new-branch-input") && e.key === "Enter") { e.preventDefault(); void this.createWorktree(); return; }
      if ((e.key === "Enter" || e.key === " ") && !e.target.matches("button,input")) {
        const t = e.target.closest("[data-act]");
        if (t) { e.preventDefault(); t.click(); }
      }
    });
    this.addEventListener("input", e => {
      if (e.target.matches(".new-branch-input")) {
        store.state.worktreeBranch = e.target.value;
        store.state.worktreeRemote = "";
      }
    });
    this.addEventListener("change", e => {
      if (e.target.matches("[data-worktree-fork]")) store.set({ worktreeFork: e.target.checked });
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
      store.set({ view: "settings", workspaceSettingsOpen: false, worktreeFormOpen: false });
    } else if (act === "workspace-settings") {
      store.set(s => ({ workspaceSettingsOpen: !s.workspaceSettingsOpen, worktreeFormOpen: false, workspaceError: null }));
    } else if (act === "close-workspace-settings") {
      store.set({ workspaceSettingsOpen: false, worktreeFormOpen: false, workspaceError: null });
    } else if (act === "files") {
      this.dispatchEvent(new CustomEvent("toggle-files", { bubbles: true }));
    } else if (act === "open-worktree") {
      store.set({ worktreeFormOpen: true, workspaceError: null, worktreeFork: false });
    } else if (act === "cancel-worktree") {
      store.set({ worktreeFormOpen: false, workspaceError: null, worktreeBranch: "", worktreeRemote: "", worktreeFork: false });
    } else if (act === "select-worktree") {
      store.set({ worktreeBranch: t.dataset.branch || "", worktreeRemote: t.dataset.remote || "", workspaceError: null });
    } else if (act === "create-worktree") {
      await this.createWorktree();
    } else if (act === "pull") {
      await this.pull();
    } else if (act === "merge") {
      const node = store.findSession(store.state.sessionId);
      const sessions = store.sessionsUsingWorkspace(node?.workspacePath);
      store.set({ workspaceSettingsOpen: false, confirm: { type: "merge", id: store.state.sessionId, branch: this.sessionBranch(), sessions, error: null } });
    } else if (act === "workspace-session") {
      const p = store.project();
      if (p && t.dataset.id) selectSession(p.id, t.dataset.id);
      store.set({ workspaceSettingsOpen: false });
    } else if (act === "hook") {
      await this.runHook(t.dataset.hook);
    } else if (act === "close-hook-result") {
      store.set({ hookResult: null });
    }
  }

  async runHook(name) {
    const id = store.state.sessionId;
    if (!id || !name) return;
    try {
      const result = await api.hook(id, name);
      store.set({ hookResult: result });
      await refreshState();
    } catch (err) {
      store.set({ hookResult: { hook: name, ok: false, exit: err.status || 1, stdout: err.stdout || "", stderr: err.stderr || err.message || err.error || "Hook failed." } });
    }
  }

  async createWorktree() {
    const id = store.state.sessionId;
    if (!id || this.worktreeBusy) return;
    this.worktreeBusy = true;
    store.set({ workspaceError: null });
    try {
      const result = await api.worktree(id, {
        branch: store.state.worktreeBranch.trim(),
        fromRef: store.state.worktreeRemote || undefined,
        fork: !!store.state.worktreeFork,
      });
      await refreshState();
      store.set({ workspaceSettingsOpen: !!(result.setup && !result.setup.ok), worktreeFormOpen: false, worktreeBranch: "", worktreeRemote: "", worktreeFork: false, workspaceError: null, hookResult: result.setup || null });
      if (result.id && result.id !== id) {
        store.state.openTree[id] = true;
        selectSession(store.state.projectId, result.id);
        store.set({ hookResult: result.setup || null, workspaceSettingsOpen: !!(result.setup && !result.setup.ok) });
      }
    } catch (err) {
      const messages = {
        checkout_dirty: "The project checkout has uncommitted changes; clean it before opening a fork.",
        branch_exists: "That branch already exists.",
        invalid_remote_branch: "That remote branch is no longer available.",
        fork_requires_transcript: "Start a conversation before opening it as a fork.",
        session_streaming: "Stop the current response before moving this session.",
      };
      store.set({ workspaceError: messages[err.error] || err.error || err.message || "Could not create worktree." });
    } finally {
      this.worktreeBusy = false;
      this.render();
    }
  }

  async pull() {
    const id = store.state.sessionId;
    if (!id) return;
    try {
      const result = await api.pull(id);
      store.set({ hookResult: { hook: "git pull", ok: true, exit: 0, stdout: result.stdout || "Already up to date.", stderr: result.stderr || "" } });
      await refreshState();
    } catch (err) {
      store.set({ hookResult: { hook: "git pull", ok: false, exit: err.status || 1, stdout: "", stderr: err.detail || err.message || err.error || "Git pull failed." } });
    }
  }

  sessionBranch() {
    const p = store.project();
    if (!p) return null;
    const n = store.findSession(store.state.sessionId);
    return n?.branch || p.branch;
  }

  render() {
    const active = document.activeElement;
    const preserveBranchInput = active?.matches?.(".new-branch-input");
    const branchSelection = preserveBranchInput ? [active.selectionStart, active.selectionEnd] : null;
    const s = store.state;
    const p = store.project();
    const inProject = store.inProject() && p;
    const chat = s.chats.find(x => x.id === s.chatId);
    const node = inProject ? store.findSession(s.sessionId) : null;
    const title = s.view === "settings" ? "Settings"
      : chat ? chat.title : node ? node.title : (s.chatId ? "New chat" : (p ? p.name : "Chat"));
    const branch = inProject ? this.sessionBranch() : null;
    const workspace = branch && p ? (p.workspaceStatus?.[branch] || {
      kind: branch === p.branch ? "checkout" : "worktree", path: node?.workspacePath || p.repoPath, dirty: false, ahead: 0, behind: 0, sessions: [],
    }) : null;
    const status = workspace ? this.statusBits(workspace) : "";
    const branchChip = inProject && branch ? `
      <div class="bar-sub">
        <span class="repo">${esc(p.name)}</span><span class="dot">·</span>
        <button class="branch-chip" data-act="workspace-settings" title="Open workspace settings" aria-label="Open workspace settings for ${esc(branch)}">
          <span class="bname">${esc(branch)}</span><span class="workspace-kind">${esc(workspace.kind)}</span><span class="workspace-state">${esc(status)}</span>
        </button>
      </div>` : "";
    const workspaceButton = inProject && branch
      ? `<button class="ghost-btn workspace-settings-link" data-act="workspace-settings" title="Workspace settings">Workspace</button>` : "";
    const settingsButton = `<button class="ghost-btn header-settings" data-act="settings" title="Settings" aria-label="Settings">${icon("settings")}</button>`;
    const filesBtn = inProject ? `
      <button class="ghost-btn" data-act="files" title="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        style="${s.filesOpen ? "color:var(--text)" : ""}">${icon(s.filesOpen ? "chevronRight" : "chevronLeft")}</button>` : "";
    const modal = inProject && s.workspaceSettingsOpen ? this.workspaceSettings(p, node, branch, workspace) : "";
    const sidebarOpen = mobile() ? s.drawerOpen : s.railOpen;
    const sidebarControl = mobile()
      ? `<svg width="17" height="15" viewBox="0 0 17 15" aria-hidden="true"><rect width="17" height="1.8" y="0" fill="currentColor"/><rect width="17" height="1.8" y="6.6" fill="currentColor"/><rect width="17" height="1.8" y="13.2" fill="currentColor"/></svg>`
      : icon(sidebarOpen ? "chevronLeft" : "chevronRight");
    this.innerHTML = `<header class="bar">
      <button class="hamburger" data-act="sidebar-toggle" title="${sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}" aria-expanded="${sidebarOpen}">${sidebarControl}</button>
      <div class="bar-main"><div class="bar-title">${esc(title)}</div>${branchChip}</div>
      ${filesBtn}${workspaceButton}${settingsButton}${modal}
    </header>`;
    if (preserveBranchInput) {
      const input = this.querySelector(".new-branch-input");
      if (input) {
        input.focus();
        if (branchSelection) input.setSelectionRange(...branchSelection);
      }
    }
  }

  statusBits(status) {
    return [status.dirty ? "dirty" : "clean", status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" · ");
  }

  workspaceSettings(p, node, branch, workspace) {
    const s = store.state;
    const sessions = store.sessionsUsingWorkspace(node?.workspacePath || workspace.path);
    const hasTranscript = (store.transcript(s.sessionId).records || []).length > 0;
    const sessionRows = sessions.length
      ? sessions.map(session => `<button class="workspace-session ${session.streaming ? "streaming" : ""}" data-act="workspace-session" data-id="${esc(session.id)}"><span class="workspace-session-dot"></span><span class="workspace-session-main"><strong>${esc(session.title)}</strong><small>${session.streaming ? "working" : "idle"}</small></span><span class="workspace-session-when">${esc(session.when || "")}</span></button>`).join("")
      : `<div class="workspace-empty">No sessions are using this workspace.</div>`;
    const branches = (p.branches || []).map(value => `<button class="workspace-branch-option" data-act="select-worktree" data-branch="${esc(value)}">${esc(value)}${p.worktrees?.[value] ? "" : " · no worktree yet"}</button>`).join("");
    const remotes = (p.remoteBranches || []).map(value => {
      const local = value.includes("/") ? value.slice(value.indexOf("/") + 1) : value;
      return `<button class="workspace-branch-option remote" data-act="select-worktree" data-branch="${esc(local)}" data-remote="${esc(value)}">${esc(value)}</button>`;
    }).join("");
    const hookResult = s.hookResult ? `<div class="hook-result ${s.hookResult.ok ? "ok" : "failed"}"><div class="hook-result-head"><strong>${esc(s.hookResult.hook || "hook")}</strong><span>exit ${esc(s.hookResult.exit)}</span><button class="ghost-btn" data-act="close-hook-result" title="Close">×</button></div>${s.hookResult.stdout ? `<pre>${esc(s.hookResult.stdout)}</pre>` : ""}${s.hookResult.stderr ? `<pre class="hook-stderr">${esc(s.hookResult.stderr)}</pre>` : ""}</div>` : "";
    const form = s.worktreeFormOpen ? `<div class="worktree-form"><label class="workspace-label" for="worktree-branch">Branch name</label><input id="worktree-branch" class="new-branch-input" placeholder="leave blank for an automatic name" aria-label="Worktree branch name" value="${esc(s.worktreeBranch)}">${branches || remotes ? `<div class="workspace-branch-options"><span>Existing branches</span>${branches}${remotes}</div>` : ""}<label class="workspace-check"><input type="checkbox" data-worktree-fork ${hasTranscript ? "" : "disabled"} ${s.worktreeFork && hasTranscript ? "checked" : ""}><span>Open as fork</span><small>${hasTranscript ? "Create a child session and leave this session here." : "Start a conversation before opening it as a fork."}</small></label>${s.workspaceError ? `<div class="workspace-error">${esc(s.workspaceError)}</div>` : ""}<div class="workspace-actions"><button class="settings-action quiet" data-act="cancel-worktree">Cancel</button><button class="settings-save" data-act="create-worktree" ${this.worktreeBusy ? "disabled" : ""}>${this.worktreeBusy ? "Creating…" : "Create worktree"}</button></div></div>` : "";
    const setup = !!p.hooks?.setup;
    const manualHooks = Object.entries(p.hooks || {}).filter(([name, enabled]) => enabled && name !== "setup").map(([name]) => `<button class="settings-action" data-act="hook" data-hook="${esc(name)}">Run ${esc(name)}</button>`).join("");
    return `<div class="workspace-scrim" data-act="close-workspace-settings"><section class="workspace-modal" role="dialog" aria-label="Workspace settings"><div class="workspace-modal-head"><div><div class="modal-title">Workspace settings</div><div class="workspace-subtitle">${esc(p.name)} · ${esc(workspace.kind)} · <span class="settings-mono">${esc(workspace.path || "")}</span></div></div><button class="ghost-btn" data-act="close-workspace-settings" aria-label="Close workspace settings">×</button></div><div class="workspace-scroll"><section class="workspace-section"><div class="workspace-section-title">Git workspace</div><div class="workspace-summary"><strong>${esc(branch)}</strong><span>${esc(this.statusBits(workspace))}</span></div><div class="workspace-sessions-title">Sessions using this workspace</div><div class="workspace-sessions">${sessionRows}</div><div class="workspace-actions"><button class="settings-action" data-act="open-worktree">Worktree</button><button class="settings-action" data-act="pull">Pull</button>${workspace.kind === "worktree" ? `<button class="settings-save" data-act="merge">Merge</button>` : ""}</div>${form}</section><section class="workspace-section"><div class="workspace-section-title">Workspace setup</div><div class="workspace-help">${setup ? "A setup hook is configured for this project. It runs after connecting a repository or creating a worktree." : "No setup hook is configured. New worktrees use the repository as-is."}</div><div class="workspace-actions">${setup ? `<button class="settings-action" data-act="hook" data-hook="setup">Run setup</button>` : ""}${manualHooks}</div>${hookResult}</section></div></section></div>`;
  }
}

customElements.define("pi-sidebar", PiSidebar);
customElements.define("pi-header", PiHeader);
