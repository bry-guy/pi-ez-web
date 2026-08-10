import { api, refreshState } from "./api.js";
import { store } from "./store.js";
import { esc, mobile, selectSession } from "./shell.js";

/* ---------------- projects screen ---------------- */
class PiProjects extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-project]")) {
        e.preventDefault(); e.target.closest("[data-project]").click();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  onClick(e) {
    const card = e.target.closest("[data-project]");
    if (card) {
      const p = store.state.projects.find(x => x.id === card.dataset.project);
      if (!p) return;
      store.state.openTree[p.id] = true;
      if (p.sessions[0]) selectSession(p.id, p.sessions[0].id);
      return;
    }
    if (e.target.closest("[data-act='repo-picker']")) store.set({ repoPickerOpen: true });
  }

  count(nodes) { return nodes.reduce((n, x) => n + 1 + this.count(x.children), 0); }
  branches(nodes, set = new Set()) {
    for (const n of nodes) { if (n.branch) set.add(n.branch); this.branches(n.children, set); }
    return set;
  }

  render() {
    const cards = store.state.projects.map(p => `
      <div class="card" role="button" tabindex="0" data-project="${esc(p.id)}">
        <div class="card-top">
          <div class="card-initial">${esc(p.name.slice(0, 2))}</div>
          <div class="card-mid">
            <div class="card-name">${esc(p.name)}</div>
            <div class="card-blurb">${esc(p.repoPath)}</div>
          </div>
          <span class="card-branch">${esc(p.branch || "—")}</span>
        </div>
        <div class="card-meta">
          <span>${this.count(p.sessions)} sessions</span>
          <span>${this.branches(p.sessions).size || 1} branches</span>
          <span>${esc(p.updated || "")}</span>
        </div>
      </div>`).join("");
    this.innerHTML = `<div class="col-pad">
      <div class="proj-head">
        <div>
          <div class="screen-title">Projects</div>
          <div class="proj-sub">One repo each. Sessions branch inside.</div>
        </div>
        <button class="connect-btn" data-act="repo-picker">Connect repo</button>
      </div>
      <div class="cards">${cards || `<div class="modal-empty">No projects yet — connect a repo.</div>`}</div>
    </div>`;
  }
}

/* ---------------- settings ---------------- */
class PiSettings extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='save-repos-root']")) this.saveReposRoot();
    });
    this.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches(".repos-root-input")) {
        e.preventDefault();
        this.saveReposRoot();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }
  async saveReposRoot() {
    const input = this.querySelector(".repos-root-input");
    if (!input) return;
    const value = input.value.trim() || null;
    const previous = store.state.reposRoot;
    try {
      const result = await api.settings(undefined, value);
      store.set({ reposRoot: result.reposRoot || null, reposRootSource: result.reposRootSource || "default", repos: [] });
      store.setError("Repository path saved.", 2200);
    } catch (err) {
      input.focus();
      store.set({ reposRoot: previous });
      store.setError(`Repository path failed: ${err.error || err.message || err}`);
    }
  }
  render() {
    this.innerHTML = `<div class="col-pad">
      <div class="screen-title">Settings</div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Model</div><div class="sr-sub">Used for new sessions.</div></div>
          <pi-model-picker data-mode="default" data-variant="settings"></pi-model-picker>
        </div>
        <div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Local repositories</div><div class="sr-sub">Folder scanned by the project picker. Empty uses <span class="settings-mono">~/src</span>${store.state.reposRootSource === "environment" ? ". <span class=\"settings-mono\">PI_WEB_REPOS_ROOT</span> currently overrides this value" : ""}.</div></div>
          <div class="settings-path-control">
            <input class="repos-root-input" aria-label="Local repositories path" value="${esc(store.state.reposRoot || "")}" placeholder="~/src">
            <button class="settings-save" data-act="save-repos-root">Save</button>
          </div>
        </div>
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Agent endpoint</div><div class="sr-sub">Pi SDK in-process, streaming over SSE.</div></div>
          <span class="settings-mono">/api/events</span>
        </div>
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Mode</div><div class="sr-sub">${store.state.mode === "mock" ? "Mock supervisor (scripted turns)" : "Pi agent via ~/.pi/agent"}</div></div>
          <span class="status-dot"></span>
        </div>
      </div>
    </div>`;
  }
}

/* ---------------- file panel ---------------- */
class PiFiles extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "files") this.render(); });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='close']")) { store.set({ filesOpen: false }); return; }
      const row = e.target.closest("[data-dir]");
      if (row) { store.state.openDirs[row.dataset.dir] = !store.state.openDirs[row.dataset.dir]; this.render(); }
    });
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-dir]")) {
        e.preventDefault(); e.target.closest("[data-dir]").click();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  rows(nodes, depth, prefix, out) {
    const sorted = nodes.slice().sort((a, b) => (!!b.c - !!a.c) || a.n.localeCompare(b.n));
    for (const n of sorted) {
      const path = prefix + "/" + n.n;
      const dir = !!n.c;
      const open = !!store.state.openDirs[path];
      out.push(`<div class="file-row ${dir ? "dir" : ""}" ${dir ? `role="button" tabindex="0" aria-expanded="${open}" data-dir="${esc(path)}"` : ""} style="margin-left:${depth * 13}px">
        <span class="fcaret">${dir ? (open ? "▾" : "▸") : "·"}</span>
        <span class="fname">${esc(n.n)}</span>
      </div>`);
      if (dir && open) this.rows(n.c, depth + 1, path, out);
    }
  }

  render() {
    if (!(store.inProject() && store.state.filesOpen)) { this.innerHTML = ""; return; }
    const out = [];
    this.rows(store.state.files, 0, "", out);
    this.innerHTML = `<aside class="files">
      <div class="files-head">
        <div class="sec-label">Files</div>
        <button class="ghost-btn" data-act="close" title="Collapse">×</button>
      </div>
      ${store.state.fileError ? `<div class="file-error">${esc(store.state.fileError)}</div>` : ""}
      <div class="files-scroll">${out.join("")}</div>
    </aside>`;
  }
}

/* ---------------- repo picker ---------------- */
class PiRepoPicker extends HTMLElement {
  connectedCallback() {
    this.repoRoot = store.state.reposRoot;
    this.unsub = store.subscribe(w => {
      if (w !== "state") return;
      const rootChanged = this.repoRoot !== null && this.repoRoot !== store.state.reposRoot;
      this.repoRoot = store.state.reposRoot;
      if (rootChanged) this.loaded = false;
      this.render();
      if (rootChanged && store.state.repoPickerOpen) void this.load();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-repo]")) {
        e.preventDefault(); e.target.closest("[data-repo]").click();
      }
    });
    this.addEventListener("input", e => {
      if (e.target.matches(".modal-filter")) { store.state.repoQuery = e.target.value; this.renderResults(); }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async onClick(e) {
    const scrim = this.querySelector(".scrim");
    if (e.target === scrim || e.target.closest("[data-act='close']")) {
      store.set({ repoPickerOpen: false }); return;
    }
    const row = e.target.closest("[data-repo]");
    if (!row) return;
    try {
      const { id, sessionId } = await api.newProject(row.dataset.repo);
      store.set({ repoPickerOpen: false });
      await refreshState();
      store.state.openTree[id] = true;
      selectSession(id, sessionId);
    } catch (err) {
      this.errorMsg = err.error === "project_exists" ? "Already connected." : err.error === "not_a_git_repo" ? "Not a git repository." : String(err.error || err);
      this.renderResults();
    }
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const { repos, root } = await api.repos();
      store.set({ repos, reposRoot: root });
    } catch (err) {
      this.errorMsg = `Could not load repositories: ${err.error || err.message || err}`;
      store.set({ repos: [] });
    }
  }

  render() {
    if (!store.state.repoPickerOpen) { this.innerHTML = ""; this.loaded = false; this.errorMsg = null; return; }
    if (!this.querySelector(".scrim")) {
      this.innerHTML = `<div class="scrim">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title-row">
              <div class="modal-title">Select a repository</div>
              <button class="ghost-btn" data-act="close" style="font-size:15px">×</button>
            </div>
            <div class="modal-filter-row">
              <span class="account-chip">local ▾</span>
              <input class="modal-filter" placeholder="Find a repository" aria-label="Find a repository">
            </div>
          </div>
          <div class="modal-list"></div>
        </div>
      </div>`;
    }
    const inp = this.querySelector(".modal-filter");
    if (inp && inp.value !== store.state.repoQuery && document.activeElement !== inp) inp.value = store.state.repoQuery;
    this.renderResults();
    this.load();
  }

  renderResults() {
    const list = this.querySelector(".modal-list");
    if (!list) return;
    const raw = store.state.repoQuery.trim();
    const q = raw.toLowerCase();
    const results = store.state.repos.filter(r => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    // Typing an absolute (or ~/) path connects a repo outside the scanned root.
    const isPath = raw.startsWith("/") || raw.startsWith("~/") || raw === "~";
    const pathRow = isPath ? `
      <div class="repo-row" role="button" tabindex="0" data-repo="${esc(raw)}">
        <div class="rr-main">
          <div class="rr-name">Connect ${esc(raw)}</div>
          <div class="rr-meta"><span>use this path directly</span></div>
        </div>
        <span class="rr-vis">path</span>
      </div>` : "";
    const rows = results.map(r => `
      <div class="repo-row" role="button" tabindex="0" data-repo="${esc(r.path)}">
        <div class="rr-main">
          <div class="rr-name">${esc(r.name)}</div>
          <div class="rr-meta"><span>${esc(r.path)}</span></div>
        </div>
        <span class="rr-vis">local</span>
      </div>`).join("");
    const empty = `<div class="modal-empty">No repositories ${q ? "match" : `found under ${esc(store.state.reposRoot || "the repos root")}`}.<br>Type an absolute path to a git repo to connect it, or set PI_WEB_REPOS_ROOT.</div>`;
    list.innerHTML = `${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}${pathRow}${rows || (pathRow ? "" : empty)}`;
  }
}

/* ---------------- confirmation modal (merge / close) ---------------- */
class PiConfirm extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => {
      const scrim = this.querySelector(".confirm-scrim");
      if (e.target === scrim || e.target.closest("[data-act='cancel']")) {
        store.set({ confirm: null });
      } else if (e.target.closest("[data-act='go']")) {
        this.go();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async go() {
    const c = store.state.confirm;
    if (!c) return;
    try {
      if (c.type === "merge") await api.merge(c.id);
      else await api.close(c.id);
      store.set({ confirm: null });
    } catch (err) {
      const msgs = {
        merge_conflict: "merge conflict — the checkout was restored; resolve by hand or keep working",
        workspace_dirty: "worktree has uncommitted changes — commit them first",
        checkout_dirty: "the project checkout has uncommitted changes",
        session_streaming: "session is mid-turn — stop it first",
      };
      store.set(s => ({ confirm: { ...s.confirm, error: msgs[err.error] || err.error || "failed" } }));
    }
  }

  render() {
    const c = store.state.confirm;
    if (!c) { this.innerHTML = ""; return; }
    const p = store.project();
    const target = p?.branch || "main";
    const isMerge = c.type === "merge";
    const title = isMerge ? "Merge branch" : c.kind === "chat" ? "Close chat" : "Close session";
    const body = isMerge
      ? `Merge ${esc(c.branch)} into ${esc(target)}. The session stays open and continues on ${esc(target)}.`
      : `“${esc(c.label)}” will be closed and removed from the list. Its transcript stays in session storage.`;
    const warn = !isMerge && c.branch && c.branch !== target
      ? `The worktree for ${esc(c.branch)} will be removed. Any changes on this branch will be lost.` : "";
    const cta = isMerge ? "Merge" : c.kind === "chat" ? "Close chat" : "Close session";
    this.innerHTML = `<div class="confirm-scrim">
      <div class="confirm-modal">
        <div class="confirm-title">${title}</div>
        <div class="confirm-body">${body}</div>
        ${warn ? `<div class="confirm-warn">${warn}</div>` : ""}
        ${c.error ? `<div class="confirm-error">${esc(c.error)}</div>` : ""}
        <div class="confirm-actions">
          <button class="confirm-back" data-act="cancel">Go back</button>
          <button class="confirm-cta ${isMerge ? "accent" : "danger"}" data-act="go">${cta}</button>
        </div>
      </div>
    </div>`;
  }
}

/* ---------------- app root ---------------- */
class PiApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="frame"><div class="shell">
        <pi-sidebar></pi-sidebar>
        <main class="col">
          <pi-header></pi-header>
          <div class="screen" data-screen="chat">
            <div class="scrollable"><div class="col-pad"><pi-thread></pi-thread></div></div>
            <pi-composer></pi-composer>
          </div>
          <div class="screen" data-screen="projects"><div class="scrollable"><pi-projects></pi-projects></div></div>
          <div class="screen" data-screen="settings"><div class="scrollable"><pi-settings></pi-settings></div></div>
        </main>
        <pi-files></pi-files>
        <div class="drawer-scrim hidden"></div>
        <pi-repo-picker></pi-repo-picker>
        <pi-confirm></pi-confirm>
        <div class="reload-prompt hidden" data-reload-prompt>
          <div class="reload-card"><div class="screen-title">Reload required</div><div class="proj-sub" data-reload-message></div><button class="primary-btn" data-act="reload">Reload</button></div>
        </div>
      </div></div>`;
    this.scrim = this.querySelector(".drawer-scrim");
    this.scrim.addEventListener("click", () => store.set({ drawerOpen: false }));
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='reload']")) location.reload();
    });
    this.addEventListener("toggle-files", () => {
      const open = !store.state.filesOpen;
      store.set({ filesOpen: open, fileError: null });
      if (!open) return;
      this.ensureFiles(true);
    });
    this.unsub = store.subscribe(w => { if (w === "state") this.sync(); });
    this.sync();
  }
  disconnectedCallback() { this.unsub?.(); }

  filesKey() {
    const p = store.project();
    if (!p || !store.inProject()) return null;
    const node = store.findSession(store.state.sessionId);
    return `${p.id}:${node?.workspacePath || node?.branch || p.branch || ""}`;
  }

  async ensureFiles(force = false) {
    if (!(store.inProject() && store.state.filesOpen)) return;
    const key = this.filesKey();
    if (!key || (!force && (key === this.loadedFilesKey || key === this.loadingFilesKey))) return;
    this.loadingFilesKey = key;
    store.state.files = [];
    store.state.fileError = null;
    store.notify("files");
    const node = store.findSession(store.state.sessionId);
    try {
      const { tree } = await api.files(store.state.projectId, node?.branch);
      if (this.filesKey() === key) {
        store.state.files = tree;
        store.state.filesContext = key;
        this.loadedFilesKey = key;
        store.notify("files");
      }
    } catch (err) {
      if (this.filesKey() === key) {
        store.state.fileError = `Could not load files: ${err.error || err.message || err}`;
        store.notify("files");
      }
    } finally {
      if (this.loadingFilesKey === key) this.loadingFilesKey = null;
    }
  }

  sync() {
    const v = store.state.view;
    for (const el of this.querySelectorAll("[data-screen]")) el.classList.toggle("hidden", el.dataset.screen !== v);
    this.scrim.classList.toggle("hidden", !(mobile() && store.state.drawerOpen));
    const prompt = this.querySelector("[data-reload-prompt]");
    prompt.classList.toggle("hidden", !store.state.fatalError);
    if (store.state.fatalError) this.querySelector("[data-reload-message]").textContent = store.state.fatalError;
    if (store.state.filesOpen && store.inProject()) void this.ensureFiles();
  }
}

customElements.define("pi-confirm", PiConfirm);
customElements.define("pi-projects", PiProjects);
customElements.define("pi-settings", PiSettings);
customElements.define("pi-files", PiFiles);
customElements.define("pi-repo-picker", PiRepoPicker);
customElements.define("pi-app", PiApp);
