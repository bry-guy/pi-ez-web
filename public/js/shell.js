import { api, openTranscript, refreshState } from "./api.js";
import { store } from "./store.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const mobile = () => matchMedia("(max-width: 760px)").matches;

export function selectSession(projectId, sessionId) {
  const project = store.state.projects.find(p => p.id === projectId);
  const node = findNode(project?.sessions, sessionId);
  store.set({
    view: "chat", projectId, sessionId, chatId: null, drawerOpen: false,
    filesOpen: store.state.filesOpen, files: [], fileError: null,
    filesContext: node ? `${projectId}:${node.workspacePath || node.branch || ""}` : null,
    branchMenuOpen: false, model: node?.model || store.state.defaultModel || null,
  });
  openTranscript(sessionId);
}
export function selectChat(chatId) {
  const chat = store.state.chats.find(c => c.id === chatId);
  store.set({
    view: "chat", chatId, sessionId: null, projectId: null, drawerOpen: false,
    branchMenuOpen: false, filesOpen: false, files: [], fileError: null,
    filesContext: null, model: chat?.model || store.state.defaultModel || null,
  });
  openTranscript(chatId);
}
export async function newChat() {
  const { id } = await api.newChat();
  await refreshState();
  selectChat(id);
}

export async function newProjectSession(projectId) {
  const { id } = await api.newProjectSession(projectId);
  await refreshState();
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
    if (act === "collapse") store.set(s => (mobile() ? { drawerOpen: false } : { railOpen: !s.railOpen }));
    else if (act === "new-chat") newChat().catch(err => store.setError(`Could not create chat: ${err.message || err}`));
    else if (act === "new-project-session") {
      e.stopPropagation();
      newProjectSession(t.dataset.id).catch(err => store.setError(`Could not create session: ${err.error || err.message || err}`));
    } else if (act === "repo-picker") store.set({ repoPickerOpen: true, drawerOpen: false });
    else if (act === "projects") store.set({ view: "projects", drawerOpen: false });
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
      out.push(`<div class="row-wrap nested" style="margin-left:${13 + depth * 13}px">
        <div class="row ${sel ? "active" : ""}" role="button" tabindex="0" ${kids ? `aria-expanded="${open || !!q}"` : ""} data-act="session-row" data-id="${esc(n.id)}" data-pid="${esc(p.id)}" data-kids="${kids ? 1 : 0}">
          <span class="caret">${kids ? ((open || q) ? "▾" : "▸") : "·"}</span>
          <span class="lbl">${esc(n.title)}</span>
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
          <button class="mini-btn quiet" data-act="projects" title="Projects">▤</button>
          <div class="mini-flex"></div>
          <button class="mini-btn quiet" data-act="settings" title="Settings">⚙</button>
        </aside>`;
        return;
      }
      if (layout === "empty") { this.innerHTML = ""; return; }
      this.innerHTML = `<aside class="rail">
        <div class="rail-head">
          <div class="rail-logo">π</div><div class="rail-word">pi</div>
          <button class="ghost-btn" data-act="collapse" title="Collapse sidebar">«</button>
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
          <button class="ghost-btn" data-act="settings" title="Settings" style="font-size:13px">⚙</button>
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
      .map(cRow => `<div class="row ${s.chatId === cRow.id ? "active" : ""}" role="button" tabindex="0" data-act="chat-row" data-id="${esc(cRow.id)}">
        <span class="lbl">${esc(cRow.title)}</span><span class="when">${esc(cRow.when)}</span>
        <button class="row-close" data-act="close-row" data-kind="chat" data-id="${esc(cRow.id)}"
          data-label="${esc(cRow.title)}" data-branch="" title="Close chat">×</button>
      </div>`).join("");
    this.querySelector(".projects-list").innerHTML = projRows.join("");
    this.querySelector(".chats-list").innerHTML = chatRows;
  }
}

/* ---------------- header ---------------- */
class PiHeader extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.render(); });
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
  disconnectedCallback() { this.unsub?.(); }

  async onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "drawer") store.set({ drawerOpen: true });
    else if (act === "branch-menu") store.set(s => ({ branchMenuOpen: !s.branchMenuOpen, branchError: null }));
    else if (act === "close-branch-menu") store.set({ branchMenuOpen: false, branchError: null });
    else if (act === "files") this.dispatchEvent(new CustomEvent("toggle-files", { bubbles: true }));
    else if (act === "switch-branch") this.switchBranch(t.dataset.branch);
    else if (act === "create-branch") this.createBranch();
    else if (act === "merge") {
      const branch = this.sessionBranch();
      store.set({ confirm: { type: "merge", id: store.state.sessionId, branch } });
    }
  }

  async switchBranch(branch) {
    const id = store.state.sessionId;
    try {
      await api.branch(id, branch, false);
      store.set({ branchMenuOpen: false, branchError: null });
      await refreshState();
    } catch (err) {
      const msg = err.error === "branch_occupied"
        ? `branch in use by ${err.byTitle || err.bySessionId}`
        : err.error === "session_streaming" ? "session is mid-turn" : (err.error || "failed");
      store.set({ branchError: msg });
    }
  }
  async createBranch() {
    const name = store.state.newBranch.trim().replace(/\s+/g, "-");
    if (!name) { store.set({ branchError: "enter a branch name" }); return; }
    const id = store.state.sessionId;
    try {
      await api.branch(id, name, true);
      store.set({ branchMenuOpen: false, newBranch: "", branchError: null });
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
    const title = s.view === "projects" ? "Projects" : s.view === "settings" ? "Settings"
      : chat ? chat.title : node ? node.title : (s.chatId ? "New chat" : (p ? p.name : "Chat"));
    const branch = inProject ? this.sessionBranch() : null;
    const streaming = store.transcript().streaming;

    const showMerge = inProject && branch && branch !== p.branch;
    const branchChip = inProject && branch ? `
      <div class="bar-sub">
        <span class="repo">${esc(p.name)}</span><span class="dot">·</span>
        <button class="branch-chip" data-act="branch-menu" title="Switch branch" ${streaming ? "disabled" : ""}>
          <span class="bname">${esc(branch)}</span><span class="bcaret">▾</span>
        </button>
        ${showMerge ? `<button class="merge-btn" data-act="merge" title="Merge this branch" ${streaming ? "disabled" : ""}>merge</button>` : ""}
      </div>` : "";

    const pop = inProject && s.branchMenuOpen ? this.popover(p, branch) : "";
    const filesBtn = inProject ? `
      <button class="ghost-btn" data-act="files" title="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        style="${s.filesOpen ? "color:var(--text)" : ""}">${s.filesOpen ? "»" : "«"}</button>` : "";

    this.innerHTML = `<header class="bar">
      ${mobile() ? `<button class="hamburger" data-act="drawer" title="Menu">
        <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><rect width="14" height="1.6" y="0" fill="currentColor"/><rect width="14" height="1.6" y="5.2" fill="currentColor"/><rect width="14" height="1.6" y="10.4" fill="currentColor"/></svg>
      </button>` : ""}
      <div class="bar-main">
        <div class="bar-title">${esc(title)}</div>
        ${branchChip}
      </div>
      ${filesBtn}
      ${pop}
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
    const rows = p.branches.map(b => {
      const occ = p.occupied[b];
      const occupiedByOther = occ && occ.sessionId !== store.state.sessionId;
      const cls = ["branch-row", b === current ? "current" : "", occupiedByOther ? "occupied" : ""].join(" ");
      return `<div class="${cls}" ${occupiedByOther ? "" : `role="button" tabindex="0" data-act="switch-branch" data-branch="${esc(b)}"`}
        title="${occupiedByOther ? "in use by " + esc(occ.title) : ""}">
        <span class="check">${b === current ? "✓" : ""}</span>
        <span class="bn">${esc(b)}</span>
        <span class="bm">${occupiedByOther ? "in use" : (b === p.branch ? "default" : "")}</span>
      </div>`;
    }).join("");
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
