import { api, openTranscript, refreshState } from "./api.js";
import { store } from "./store.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const mobile = () => matchMedia("(max-width: 760px)").matches;
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
    filesOpen: store.state.filesOpen, files: [], fileError: null, hookResult: null,
    branchMenuOpen: false, model: node?.model || store.state.effectiveDefaultModel || null,
  });
  store.markRead(sessionId);
  openTranscript(sessionId);
}
export function selectChat(chatId) {
  const chat = store.state.chats.find(c => c.id === chatId);
  store.set({
    view: "chat", chatId, sessionId: null, projectId: null, drawerOpen: false,
    branchMenuOpen: false, filesOpen: false, files: [], fileError: null, hookResult: null,
    model: chat?.model || store.state.effectiveDefaultModel || null,
  });
  store.markRead(chatId);
  openTranscript(chatId);
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
function nodeMatches(n, q) {
  if (!q) return true;
  return n.title.toLowerCase().includes(q) || (n.children || []).some(child => nodeMatches(child, q));
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
    else if (act === "new-chat") newChat().catch(err => store.setError(`Could not create chat: ${err.message || err}`));
    else if (act === "new-project-session") {
      e.stopPropagation();
      newProjectSession(t.dataset.id).catch(err => store.setError(`Could not create session: ${err.error || err.message || err}`));
    } else if (act === "repo-picker") store.set({ repoPickerOpen: true, drawerOpen: false });
    else if (act === "settings") store.set({ view: "settings", drawerOpen: false });
    else if (act === "project-row") {
      const p = store.state.projects.find(x => x.id === t.dataset.id);
      if (!p) return;
      store.state.openTree[p.id] = !store.state.openTree[p.id];
      const first = p.sessions[0];
      if (first) selectSession(p.id, first.id);
      else store.set({ view: "chat", projectId: p.id, sessionId: null, chatId: null, filesOpen: false });
    } else if (act === "session-row") {
      if (t.dataset.kids === "1") store.state.openTree[t.dataset.id] = !store.state.openTree[t.dataset.id];
      selectSession(t.dataset.pid, t.dataset.id);
    } else if (act === "chat-row") selectChat(t.dataset.id);
  }

  count(nodes) { return nodes.reduce((n, x) => n + 1 + this.count(x.children), 0); }

  sessionRows(p, nodes, depth, q, out, forceAll = false) {
    for (const n of nodes) {
      const direct = !q || n.title.toLowerCase().includes(q);
      const descendant = q && (n.children || []).some(child => nodeMatches(child, q));
      if (q && !forceAll && !direct && !descendant) continue;
      const kids = n.children.length > 0;
      const open = !!store.state.openTree[n.id];
      const sel = store.state.sessionId === n.id && !store.state.chatId && store.state.view === "chat";
      const streaming = store.transcript(n.id).streaming;
      const unread = !!store.state.unread[n.id];
      out.push(`<div class="row-wrap nested" style="margin-left:${13 + depth * 13}px">
        <div class="row ${sel ? "active " : ""}${streaming ? "streaming " : ""}${unread ? "unread" : ""}" role="button" tabindex="0" ${kids ? `aria-expanded="${open || !!q}"` : ""} data-act="session-row" data-id="${esc(n.id)}" data-pid="${esc(p.id)}" data-kids="${kids ? 1 : 0}">
          <span class="caret">${kids ? ((open || q) ? "▾" : "▸") : "·"}</span>
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
          <div class="mini-flex"></div>
          <button class="mini-btn quiet" data-act="settings" title="Settings">${icon("settings")}</button>
        </aside>`;
        return;
      }
      if (layout === "empty") { this.innerHTML = ""; return; }
      this.innerHTML = `<aside class="rail">
        <div class="rail-head">
          <div class="rail-logo">π</div><div class="rail-word">pi</div>
          <button class="ghost-btn" data-act="collapse" title="Collapse sidebar">${icon("chevronLeft")}</button>
        </div>
        <div class="rail-actions">
          <input class="rail-search" placeholder="Search sessions" aria-label="Search sessions">
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
      const nameMatch = !q || p.name.toLowerCase().includes(q);
      if (q && !nameMatch && !p.sessions.some(n => nodeMatches(n, q))) continue;
      const open = !!s.openTree[p.id] || !!q;
      const active = s.view === "chat" && s.projectId === p.id && !s.chatId;
      projRows.push(`<div class="row-wrap" style="margin-top:1px">
        <div class="row mono ${active && !open ? "active" : ""}" role="button" tabindex="0" aria-expanded="${open}" data-act="project-row" data-id="${esc(p.id)}">
          <span class="caret">${open ? "▾" : "▸"}</span>
          <span class="lbl">${esc(p.name)}</span>
          <span class="count">${this.count(p.sessions)}</span>
          <button class="row-add cta-plus" data-act="new-project-session" data-id="${esc(p.id)}" title="New session in ${esc(p.name)}" aria-label="New session in ${esc(p.name)}">+</button>
        </div></div>`);
      if (open) this.sessionRows(p, p.sessions, 0, nameMatch ? "" : q, projRows, nameMatch);
    }
    const chatRows = s.chats
      .filter(cRow => !q || cRow.title.toLowerCase().includes(q))
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
      if (e.key === "Escape" && store.state.branchMenuOpen) {
        e.preventDefault();
        store.set({ branchMenuOpen: false, branchError: null });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if (e.target.matches(".new-branch-input") && e.key === "Enter") { e.preventDefault(); this.createBranch(); return; }
      if ((e.key === "Enter" || e.key === " ") && !e.target.matches("button,input")) {
        const t = e.target.closest("[data-act]");
        if (t) { e.preventDefault(); t.click(); }
      }
    });
    this.addEventListener("input", e => {
      if (e.target.matches(".new-branch-input")) store.state.newBranch = e.target.value;
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }

  async onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "drawer") store.set({ drawerOpen: true });
    else if (act === "branch-menu") store.set(s => ({ branchMenuOpen: !s.branchMenuOpen, branchError: null }));
    else if (act === "close-branch-menu") store.set({ branchMenuOpen: false, branchError: null });
    else if (act === "files") this.dispatchEvent(new CustomEvent("toggle-files", { bubbles: true }));
    else if (act === "switch-branch") this.switchBranch(t.dataset.branch, t.dataset.remoteBranch || null);
    else if (act === "create-branch") this.createBranch();
    else if (act === "merge") {
      const branch = this.sessionBranch();
      store.set({ confirm: { type: "merge", id: store.state.sessionId, branch } });
    } else if (act === "hook") {
      this.runHook(t.dataset.hook);
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
    } catch (err) {
      store.set({ hookResult: { hook: name, ok: false, exit: err.status || 1, stdout: err.stdout || "", stderr: err.stderr || err.message || err.error || "Hook failed." } });
    }
  }

  async switchBranch(branch, remoteBranch = null) {
    const id = store.state.sessionId;
    try {
      const result = await api.branch(id, branch, !!remoteBranch, remoteBranch);
      store.set({ branchMenuOpen: false, branchError: null, hookResult: result.setup || null });
      await refreshState();
    } catch (err) {
      const msg = err.error === "branch_occupied"
        ? `branch in use by ${err.byTitle || err.bySessionId}`
        : err.error === "session_streaming" ? "session is mid-turn"
          : err.error === "branch_exists" ? `that branch already exists${err.remoteBranch ? ` (${err.remoteBranch})` : ""}`
            : err.error === "invalid_remote_branch" ? "remote branch is no longer available"
              : (err.error || "failed");
      store.set({ branchError: msg });
    }
  }
  async createBranch() {
    const name = store.state.newBranch.trim().replace(/\s+/g, "-");
    if (!name) { store.set({ branchError: "enter a branch name" }); return; }
    const id = store.state.sessionId;
    try {
      const result = await api.branch(id, name, true);
      store.set({ branchMenuOpen: false, newBranch: "", branchError: null, hookResult: result.setup || null });
      await refreshState();
    } catch (err) {
      store.set({ branchError: err.error === "branch_occupied" ? "branch in use" : (err.error || "failed") });
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
    const streaming = store.transcript().streaming;
    const workspaceLock = inProject ? store.workspaceBusy(store.state.sessionId) : null;
    const blocked = streaming || !!workspaceLock;
    // A lock closes an open popover outright; suppressing the render while
    // leaving branchMenuOpen=true made it reappear when the lock cleared.
    if (blocked && s.branchMenuOpen) store.set({ branchMenuOpen: false, branchError: null });

    const showMerge = inProject && branch && branch !== p.branch;
    const branchChip = inProject && branch ? `
      <div class="bar-sub">
        <span class="repo">${esc(p.name)}</span><span class="dot">·</span>
        <button class="branch-chip" data-act="branch-menu" title="Switch branch" ${blocked ? "disabled" : ""}>
          <span class="bname">${esc(branch)}</span><span class="bcaret">▾</span>
        </button>
        ${showMerge ? `<button class="merge-btn" data-act="merge" title="Merge this branch" ${blocked ? "disabled" : ""}>merge</button>` : ""}
        ${Object.entries(p.hooks || {}).filter(([, enabled]) => enabled).map(([name]) => `<button class="hook-btn" data-act="hook" data-hook="${esc(name)}" title="Run ${esc(name)} hook" ${blocked ? "disabled" : ""}>${esc(name)}</button>`).join("")}
      </div>` : "";

    const pop = inProject && s.branchMenuOpen ? this.popover(p, branch) : "";
    const filesBtn = inProject ? `
      <button class="ghost-btn" data-act="files" title="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        style="${s.filesOpen ? "color:var(--text)" : ""}">${icon(s.filesOpen ? "chevronRight" : "chevronLeft")}</button>` : "";

    const hookResult = store.state.hookResult;
    const hookPanel = hookResult ? `<div class="hook-result ${hookResult.ok ? "ok" : "failed"}"><div class="hook-result-head"><strong>${esc(hookResult.hook || "hook")}</strong><span>exit ${esc(hookResult.exit)}</span><button class="ghost-btn" data-act="close-hook-result" title="Close">×</button></div>${hookResult.stdout ? `<pre>${esc(hookResult.stdout)}</pre>` : ""}${hookResult.stderr ? `<pre class="hook-stderr">${esc(hookResult.stderr)}</pre>` : ""}</div>` : "";
    this.innerHTML = `<header class="bar">
      ${mobile() ? `<button class="hamburger" data-act="drawer" title="Menu">
        <svg width="17" height="15" viewBox="0 0 17 15" aria-hidden="true"><rect width="17" height="1.8" y="0" fill="currentColor"/><rect width="17" height="1.8" y="6.6" fill="currentColor"/><rect width="17" height="1.8" y="13.2" fill="currentColor"/></svg>
      </button>` : ""}
      <div class="bar-main">
        <div class="bar-title">${esc(title)}</div>
        ${branchChip}
      </div>
      ${filesBtn}
      ${pop}
      ${hookPanel}
    </header>`;
    if (preserveBranchInput) {
      const input = this.querySelector(".new-branch-input");
      if (input) {
        input.focus();
        if (branchSelection) input.setSelectionRange(...branchSelection);
      }
    }
  }

  popover(p, current) {
    const localRows = (p.branches || []).map(b => {
      const occ = p.occupied[b];
      const occupiedByOther = occ && occ.sessionId !== store.state.sessionId;
      const occStreaming = occupiedByOther && store.transcript(occ.sessionId).streaming;
      const cls = ["branch-row", b === current ? "current" : "", occupiedByOther ? "occupied" : ""].join(" ");
      const kind = b === p.branch ? "default" : p.worktrees?.[b] ? "worktree" : "local";
      return `<div class="${cls}" ${occupiedByOther ? "" : `role="button" tabindex="0" data-act="switch-branch" data-branch="${esc(b)}"`}
        title="${occupiedByOther ? "in use by " + esc(occ.title) : ""}">
        <span class="check">${b === current ? "✓" : ""}</span>
        <span class="bn">${esc(b)}</span>
        <span class="bm">${occupiedByOther ? (occStreaming ? "in use · streaming" : "in use") : kind}</span>
      </div>`;
    });
    const remoteRows = (p.remoteBranches || []).map(remote => {
      const slash = remote.indexOf("/");
      const local = slash >= 0 ? remote.slice(slash + 1) : remote;
      const localExists = (p.branches || []).includes(local);
      const occ = p.occupied[local];
      const occupiedByOther = occ && occ.sessionId !== store.state.sessionId;
      const cls = ["branch-row", occupiedByOther || localExists ? "occupied" : ""].join(" ");
      const action = occupiedByOther || localExists
        ? ""
        : `role="button" tabindex="0" data-act="switch-branch" data-branch="${esc(local)}" data-remote-branch="${esc(remote)}"`;
      return `<div class="${cls}" ${action}
        title="${occupiedByOther ? "in use by " + esc(occ.title) : localExists ? "local branch already exists for " + esc(remote) : "Create a local branch from " + esc(remote)}">
        <span class="check">${localExists ? "·" : ""}</span>
        <span class="bn">${esc(remote)}</span>
        <span class="bm">${occupiedByOther ? "in use" : localExists ? "local exists" : "remote"}</span>
      </div>`;
    });
    const rows = [...localRows, ...remoteRows].join("");
    return `
      <div class="popover-scrim" data-act="close-branch-menu"></div>
      <div class="branch-pop">
        <div class="pop-head">Switch branch</div>
        <div class="pop-list">${rows}</div>
        ${store.state.branchError ? `<div class="pop-error">${esc(store.state.branchError)}</div>` : ""}
        <div class="pop-foot">
          <input class="new-branch-input" placeholder="new-branch-name" aria-label="New branch name" value="${esc(store.state.newBranch)}">
          <button class="create-btn" data-act="create-branch">Create</button>
        </div>
      </div>`;
  }
}

customElements.define("pi-sidebar", PiSidebar);
customElements.define("pi-header", PiHeader);
