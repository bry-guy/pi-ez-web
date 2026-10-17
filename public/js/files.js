import { api } from "./api.js";
import { setHTML, store } from "./store.js";
import { esc, gitStatusText, icon } from "./shell.js";

/* ---------------- file view navigation ---------------- */
// Opening a file pushes #file/<path> and replaces the chat pane; Back and "<" return to chat.
let requestId = 0;
const fileHash = filePath => `#file/${encodeURIComponent(filePath)}`;

function clearFile() {
  requestId++;
  store.set({ filePath: null, fileView: null, fileLoading: false, fileError: null });
}

export function closeFileView() {
  if (!store.state.filePath) return;
  if (history.state?.piFile) history.back(); // popstate clears the file
  else clearFile();
}

/* ---------------- file tree (right column) ---------------- */
class PiFiles extends HTMLElement {
  connectedCallback() {
    this.treeScroll = new Map();
    this.lastRenderSignature = null;
    this.unsub = store.subscribe(w => {
      if (w === "state" || w === "files") this.render();
    });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='close']")) {
        closeFileView();
        store.set({ filesOpen: false, filesLoading: false, fileError: null });
        return;
      }
      const dir = e.target.closest("[data-dir]");
      if (dir) {
        store.state.openDirs[dir.dataset.dir] = !store.state.openDirs[dir.dataset.dir];
        this.render(true);
        return;
      }
      const file = e.target.closest("[data-file]");
      if (file) void this.openFile(file.dataset.file);
    });
    this.addEventListener("change", e => {
      if (e.target.matches(".file-target")) this.changeTarget(e.target.value);
    });
    this.addEventListener("scroll", e => {
      if (e.target.matches(".files-scroll")) this.treeScroll.set(this.treeScrollKey(), e.target.scrollTop);
    }, true);
    this.addEventListener("keydown", e => {
      if ((e.key !== "Enter" && e.key !== " ") || e.target.matches("button,select")) return;
      const target = e.target.closest("[data-dir], [data-file]");
      if (!target) return;
      e.preventDefault();
      target.click();
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
  }

  currentContextId() {
    const project = store.project();
    const node = store.findSession(store.state.sessionId);
    return node?.contextId || project?.contexts?.find(context => context.kind === "checkout")?.id || project?.contexts?.[0]?.id || null;
  }

  treeScrollKey() {
    const project = store.project();
    const node = store.findSession(store.state.sessionId);
    return `${project?.id || ""}:${node?.workspacePath || node?.branch || project?.branch || ""}`;
  }

  captureScroll() {
    const tree = this.querySelector(".files-scroll");
    if (tree) this.treeScroll.set(this.treeScrollKey(), tree.scrollTop);
  }

  restoreScroll() {
    const tree = this.querySelector(".files-scroll");
    if (tree) tree.scrollTop = this.treeScroll.get(this.treeScrollKey()) ?? 0;
  }

  renderSignature() {
    const s = store.state;
    const openDirs = Object.entries(s.openDirs || {})
      .filter(([, open]) => open)
      .map(([path]) => path)
      .sort()
      .join("\\0");
    return [
      s.filesOpen,
      store.inProject(),
      this.closest("pi-app")?.filesKey?.() || null,
      s.files,
      s.fileTargets,
      s.fileTarget,
      s.filesLoading,
      s.fileError,
      openDirs,
    ];
  }

  sameRenderSignature(signature) {
    return this.lastRenderSignature
      && signature.length === this.lastRenderSignature.length
      && signature.every((value, index) => value === this.lastRenderSignature[index]);
  }

  availableTargets() {
    const targets = store.state.fileTargets;
    return Array.isArray(targets) && targets.length ? targets : ["origin", "primary"];
  }

  // Main checkout vs worktree is shown here, not in the header.
  workspaceSummary() {
    const project = store.project();
    const context = project?.contexts?.find(item => item.id === this.currentContextId());
    if (!context) return "";
    const place = context.kind === "checkout" ? "Main checkout" : `Worktree of ${project.name}`;
    return [place, context.branch, context.head?.slice(0, 8), gitStatusText(context)].filter(Boolean).join(" · ");
  }

  targetLabel(target) {
    if (target === "origin") return "vs origin";
    const project = store.project();
    return `vs ${project?.defaultBranch || project?.primaryBranch || "main"}`;
  }

  targetOptions(selected = store.state.fileTarget) {
    return [...new Set(this.availableTargets())].map(target => `<option value="${esc(target)}" ${target === selected ? "selected" : ""}>${esc(this.targetLabel(target))}</option>`).join("");
  }

  changeTarget(target) {
    if (!this.availableTargets().includes(target) || target === store.state.fileTarget) return;
    closeFileView();
    requestId++;
    store.set({ fileTarget: target, files: [], filesLoadedKey: null, filePath: null, fileView: null, fileLoading: false, filesLoading: true, fileError: null });
  }

  async openFile(filePath, target = store.state.fileTarget || "origin") {
    const projectId = store.state.projectId;
    const contextId = this.currentContextId();
    if (!projectId || !contextId || !filePath) return;
    if (!this.availableTargets().includes(target)) target = "origin";
    // A file opened from another file replaces its history entry, so one Back returns to chat.
    if (history.state?.piFile) history.replaceState(history.state, "", fileHash(filePath));
    else history.pushState({ piFile: true }, "", fileHash(filePath));
    const id = ++requestId;
    store.set({ filePath, fileView: null, fileTarget: target, fileLoading: true, fileError: null });
    try {
      const view = await api.file(projectId, contextId, filePath, target);
      if (id !== requestId || store.state.filePath !== filePath) return;
      store.set({ fileView: view, fileTargets: view.targets || store.state.fileTargets, fileTarget: view.target, fileLoading: false, fileError: null });
    } catch (err) {
      if (id !== requestId || store.state.filePath !== filePath) return;
      store.set({ fileLoading: false, fileError: `Could not load file: ${err.error || err.message || err}` });
    }
  }

  rows(nodes, depth, prefix, out) {
    // Folders first; dot-folders (.github, .config) sort after ordinary folders.
    const sorted = nodes.slice().sort((a, b) => (!!b.c - !!a.c) || (dotDir(a) - dotDir(b)) || a.n.localeCompare(b.n));
    for (const n of sorted) {
      const filePath = n.p || (prefix ? `${prefix}/${n.n}` : n.n);
      const dir = Array.isArray(n.c);
      const removed = n.s === "removed";
      const open = !!store.state.openDirs[filePath];
      const attrs = dir
        ? `role="button" tabindex="0" aria-expanded="${open}" data-dir="${esc(filePath)}"`
        : removed
          ? `aria-label="Removed ${esc(filePath)}" aria-disabled="true"`
          : `role="button" tabindex="0" aria-label="Open ${esc(filePath)}" data-file="${esc(filePath)}"`;
      const statusClass = n.s ? ` status-${esc(n.s)}` : "";
      out.push(`<div class="file-row ${dir ? "dir" : "file"}${statusClass}" ${attrs} style="margin-left:${depth * 13}px">
        <span class="fcaret">${dir ? (open ? "▾" : "▸") : "·"}</span>
        <span class="fname">${esc(n.n)}</span>
      </div>`);
      if (dir && open) this.rows(n.c, depth + 1, filePath, out);
    }
  }

  render(force = false) {
    const signature = this.renderSignature();
    if (!force && this.sameRenderSignature(signature)) return;
    this.lastRenderSignature = signature;
    this.captureScroll();
    if (!(store.inProject() && store.state.filesOpen)) {
      this.innerHTML = "";
      return;
    }
    const out = [];
    this.rows(store.state.files, 0, "", out);
    const targets = this.availableTargets();
    const selectedTarget = targets.includes(store.state.fileTarget) ? store.state.fileTarget : targets[0];
    if (store.state.fileTarget !== selectedTarget) store.state.fileTarget = selectedTarget;
    const summary = this.workspaceSummary();
    setHTML(this, `<aside class="files">
      <div class="files-head">
        <div class="sec-label">Files</div>
        <button class="ghost-btn" data-act="close" title="Collapse files" aria-label="Collapse files">${icon("chevronRight")}</button>
      </div>
      ${summary ? `<div class="file-git">${esc(summary)}</div>` : ""}
      <div class="file-target-row file-tree-target" role="group" aria-label="Diff target"><label for="file-target">Diff target</label><select id="file-target" class="file-target" aria-label="Diff target">${this.targetOptions(selectedTarget)}</select></div>
      ${store.state.fileError ? `<div class="file-error">${esc(store.state.fileError)}</div>` : ""}
      <div class="files-scroll">${out.length ? out.join("") : `<div class="file-empty">${store.state.filesLoading ? "Loading files…" : "No files found."}</div>`}</div>
    </aside>`);
    this.restoreScroll();
  }
}

const dotDir = node => (Array.isArray(node.c) && node.n.startsWith(".") ? 1 : 0);

/* ---------------- file view (replaces the chat pane) ---------------- */
class PiFileView extends HTMLElement {
  connectedCallback() {
    this.viewerScroll = new Map();
    this.lastRenderSignature = null;
    this.shownPath = null;
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.filePath) {
        e.preventDefault();
        closeFileView();
      }
    };
    // Back past the file entry (browser Back) closes the file.
    this.onPopState = () => {
      if (store.state.filePath && !location.hash.startsWith("#file/")) clearFile();
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    window.addEventListener("popstate", this.onPopState);
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='close-file']")) closeFileView();
    });
    this.addEventListener("scroll", e => {
      if (e.target.matches(".file-view-scroll") && store.state.filePath) this.viewerScroll.set(store.state.filePath, e.target.scrollTop);
    }, true);
    this.unsub = store.subscribe(w => {
      if (w === "state") this.render();
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
    window.removeEventListener("popstate", this.onPopState);
  }

  renderSignature() {
    const s = store.state;
    return [s.filePath, s.fileView, s.fileLoading, s.fileError, s.fileTarget];
  }

  safeHighlighted(value) {
    if (!value) return "";
    return globalThis.DOMPurify?.sanitize(value) || esc(value);
  }

  renderDiff(diff) {
    if (diff.binary) return `<div class="file-empty">Binary diff preview unavailable.</div>`;
    const lines = (diff.lines || []).map(line => {
      const cls = line.hunk ? "hunk" : line.sign === "+" ? "add" : line.sign === "-" ? "del" : "";
      return `<div class="diff-line ${cls}"><span class="sign">${esc(line.sign || "")}</span>${esc(line.text)}</div>`;
    }).join("");
    const stats = `${diff.adds ? `+${diff.adds}` : ""}${diff.dels ? ` −${diff.dels}` : ""}`;
    return `<div class="file-diff-meta">${esc(diff.label)} ${stats ? `· ${esc(stats)}` : "· textual metadata change"}</div>
      <div class="diff-body file-diff-body">${lines || `<div class="file-empty">No textual changes.</div>`}</div>`;
  }

  render() {
    const signature = this.renderSignature();
    if (signature.every((value, index) => value === this.lastRenderSignature?.[index])) return;
    this.lastRenderSignature = signature;
    const s = store.state;
    if (!s.filePath) {
      this.innerHTML = "";
      this.shownPath = null;
      return;
    }
    const hadFocus = this.contains(document.activeElement);
    const view = s.fileView;
    const content = view?.binary
      ? `<div class="file-empty">Binary file preview unavailable.</div>`
      : view
        ? `<pre class="file-code"><code class="hljs${view.language ? ` language-${esc(view.language)}` : ""}">${view.highlighted ? this.safeHighlighted(view.highlighted) : esc(view.content || "")}</code></pre>`
        : `<div class="file-empty">${s.fileLoading ? "Loading file…" : "Select a file to preview it."}</div>`;
    const diffMode = !!view?.diff?.changed;
    const body = diffMode ? this.renderDiff(view.diff) : content;
    const title = diffMode ? "Diff" : "Current file";
    const meta = !diffMode && view ? `<span>${esc(view.language || "text")} · ${esc(view.size)} bytes</span>` : "";
    setHTML(this, `<div class="file-screen">
      <div class="file-screen-head">
        <button class="ghost-btn" data-act="close-file" title="Back to chat" aria-label="Back to chat">${icon("chevronLeft")}</button>
        <div class="file-title-wrap"><div class="sec-label">File</div><div class="file-path" title="${esc(s.filePath)}">${esc(s.filePath)}</div></div>
      </div>
      ${s.fileError ? `<div class="file-error">${esc(s.fileError)}</div>` : ""}
      <div class="file-view-scroll">
        <section class="file-section"><div class="file-section-head"><span>${title}</span>${meta}</div>${body}</section>
      </div>
    </div>`);
    const scroll = this.querySelector(".file-view-scroll");
    if (scroll) scroll.scrollTop = this.viewerScroll.get(s.filePath) ?? 0;
    // The body re-renders when the file loads; keep focus on "<" when it was there.
    if (hadFocus || this.shownPath !== s.filePath) this.querySelector("[data-act='close-file']")?.focus();
    this.shownPath = s.filePath;
  }
}

customElements.define("pi-files", PiFiles);
customElements.define("pi-file-view", PiFileView);
