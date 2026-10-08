import { api } from "./api.js";
import { store } from "./store.js";
import { esc } from "./shell.js";


/* ---------------- file panel ---------------- */
class PiFiles extends HTMLElement {
  connectedCallback() {
    this.requestId = 0;
    this.treeScroll = new Map();
    this.viewerScroll = new Map();
    this.lastRenderSignature = null;
    this.viewerOpen = false;
    this.focusReturnPath = null;
    this.unsub = store.subscribe(w => {
      if (["state", "files", "file"].includes(w)) this.render();
    });
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.filePath) {
        e.preventDefault();
        this.close();
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => {
      const scrim = e.target.closest("[data-file-viewer-scrim]");
      if (scrim && e.target === scrim) { this.close(); return; }
      if (e.target.closest("[data-act='close']")) { this.close(); return; }
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
      else if (e.target.matches(".file-view-scroll") && store.state.filePath) this.viewerScroll.set(this.viewerScrollKey(), e.target.scrollTop);
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
    document.removeEventListener("keydown", this.onDocumentKeydown);
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

  viewerScrollKey() {
    return `${this.treeScrollKey()}:${store.state.fileTarget}:${store.state.filePath || ""}`;
  }

  captureScroll() {
    const tree = this.querySelector(".files-scroll");
    if (tree) this.treeScroll.set(this.treeScrollKey(), tree.scrollTop);
    const viewer = this.querySelector(".file-view-scroll");
    if (viewer && store.state.filePath) this.viewerScroll.set(this.viewerScrollKey(), viewer.scrollTop);
  }

  restoreScroll() {
    const tree = this.querySelector(".files-scroll");
    if (tree) tree.scrollTop = this.treeScroll.get(this.treeScrollKey()) ?? 0;
    const viewer = this.querySelector(".file-view-scroll");
    if (viewer && store.state.filePath) viewer.scrollTop = this.viewerScroll.get(this.viewerScrollKey()) ?? 0;
  }

  renderSignature() {
    const s = store.state;
    const viewing = !!s.filePath;
    const openDirs = viewing ? "" : Object.entries(s.openDirs || {})
      .filter(([, open]) => open)
      .map(([path]) => path)
      .sort()
      .join("\\0");
    return [
      s.filesOpen,
      store.inProject(),
      this.closest("pi-app")?.filesKey?.() || null,
      viewing ? null : s.files,
      viewing ? null : s.fileTargets,
      viewing ? null : s.fileTarget,
      s.filePath,
      s.fileView,
      viewing ? null : s.filesLoading,
      s.fileLoading,
      s.fileError,
      openDirs,
    ];
  }

  sameRenderSignature(signature) {
    return this.lastRenderSignature
      && signature.length === this.lastRenderSignature.length
      && signature.every((value, index) => value === this.lastRenderSignature[index]);
  }

  focusFileTrigger() {
    if (!this.focusReturnPath) return;
    const trigger = [...this.querySelectorAll("[data-file]")]
      .find(node => node.dataset.file === this.focusReturnPath);
    trigger?.focus();
    this.focusReturnPath = null;
  }

  availableTargets() {
    const targets = store.state.fileTargets;
    const primary = store.project()?.defaultBranch || store.project()?.primaryBranch || "main";
    return Array.isArray(targets) && targets.length
      ? targets
      : ["none", "HEAD", ...((store.project()?.branches || []).includes(primary) ? [primary] : [])];
  }

  targetLabel(target) {
    return target === "none" ? "Working tree" : target;
  }

  targetOptions(selected = store.state.fileTarget) {
    return [...new Set(this.availableTargets())].map(target => `<option value="${esc(target)}" ${target === selected ? "selected" : ""}>${esc(this.targetLabel(target))}</option>`).join("");
  }

  changeTarget(target) {
    if (!this.availableTargets().includes(target) || target === store.state.fileTarget) return;
    this.requestId++;
    store.set({ fileTarget: target, files: [], filesLoadedKey: null, filePath: null, fileView: null, fileLoading: false, filesLoading: true, fileError: null });
  }

  async openFile(filePath, target = store.state.fileTarget || "none") {
    const projectId = store.state.projectId;
    this.focusReturnPath = filePath;
    const contextId = this.currentContextId();
    if (!projectId || !contextId || !filePath) return;
    if (!this.availableTargets().includes(target)) target = "none";
    const requestId = ++this.requestId;
    store.set({ filePath, fileView: null, fileTarget: target, fileLoading: true, fileError: null });
    try {
      const view = await api.file(projectId, contextId, filePath, target);
      if (requestId !== this.requestId || store.state.filePath !== filePath) return;
      store.set({ fileView: view, fileTargets: view.targets || store.state.fileTargets, fileTarget: view.target, fileLoading: false, fileError: null });
    } catch (err) {
      if (requestId !== this.requestId || store.state.filePath !== filePath) return;
      store.set({ fileLoading: false, fileError: `Could not load file: ${err.error || err.message || err}` });
    }
  }

  close() {
    this.requestId++;
    if (store.state.filePath) {
      this.focusReturnPath = store.state.filePath;
      store.set({ filePath: null, fileView: null, fileLoading: false, fileError: null });
      return;
    }
    store.set({ filesOpen: false, filePath: null, fileView: null, fileLoading: false, filesLoading: false, fileError: null });
  }

  rows(nodes, depth, prefix, out) {
    const sorted = nodes.slice().sort((a, b) => (!!b.c - !!a.c) || a.n.localeCompare(b.n));
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

  safeHighlighted(value) {
    if (!value) return "";
    return globalThis.DOMPurify?.sanitize(value) || esc(value);
  }

  renderDiff(diff, target) {
    if (diff?.binary) return `<div class="file-empty">Binary diff preview unavailable.</div>`;
    if (!diff?.changed) return `<div class="file-empty">No changes against ${esc(target)}.</div>`;
    const lines = (diff.lines || []).map(line => {
      const cls = line.hunk ? "hunk" : line.sign === "+" ? "add" : line.sign === "-" ? "del" : "";
      return `<div class="diff-line ${cls}"><span class="sign">${esc(line.sign || "")}</span>${esc(line.text)}</div>`;
    }).join("");
    const stats = `${diff.adds ? `+${diff.adds}` : ""}${diff.dels ? ` −${diff.dels}` : ""}`;
    return `<div class="file-diff-meta">${esc(target)} ${stats ? `· ${esc(stats)}` : "· textual metadata change"}</div>
      <div class="diff-body file-diff-body">${lines || `<div class="file-empty">No textual changes.</div>`}</div>`;
  }

  renderViewer() {
    const s = store.state;
    const view = s.fileView;
    const content = view?.binary
      ? `<div class="file-empty">Binary file preview unavailable.</div>`
      : view
        ? `<pre class="file-code"><code class="hljs${view.language ? ` language-${esc(view.language)}` : ""}">${view.highlighted ? this.safeHighlighted(view.highlighted) : esc(view.content || "")}</code></pre>`
        : `<div class="file-empty">${s.fileLoading ? "Loading file…" : "Select a file to preview it."}</div>`;
    const target = view?.target || s.fileTarget;
    const diffMode = !!view && target !== "none";
    const body = diffMode ? this.renderDiff(view.diff, target) : content;
    const title = diffMode ? "Diff" : "Current file";
    const meta = !diffMode && view ? `<span>${esc(view.language || "text")} · ${esc(view.size)} bytes</span>` : "";
    this.innerHTML = `<div class="file-viewer-scrim" data-file-viewer-scrim>
      <aside class="files file-viewer" role="dialog" aria-modal="true" aria-label="File preview">
        <div class="files-head file-viewer-head">
          <div class="file-title-wrap"><div class="sec-label">File</div><div class="file-path" title="${esc(s.filePath || "")}">${esc(s.filePath || "")}</div></div>
          <button class="ghost-btn" data-act="close" title="Close file preview" aria-label="Close file preview">×</button>
        </div>
        ${s.fileError ? `<div class="file-error">${esc(s.fileError)}</div>` : ""}
        <div class="file-view-scroll">
          <section class="file-section"><div class="file-section-head"><span>${title}</span>${meta}</div>${body}</section>
        </div>
      </aside>
    </div>`;
  }

  render(force = false) {
    const signature = this.renderSignature();
    if (!force && this.sameRenderSignature(signature)) return;
    this.lastRenderSignature = signature;
    this.captureScroll();
    if (!(store.inProject() && store.state.filesOpen)) {
      this.viewerOpen = false;
      this.innerHTML = "";
      return;
    }
    if (store.state.filePath) {
      const closeButton = this.querySelector(".file-viewer [data-act='close']");
      const newlyOpened = !this.viewerOpen;
      const shouldFocusClose = newlyOpened || document.activeElement === closeButton;
      this.renderViewer();
      this.viewerOpen = true;
      this.restoreScroll();
      if (shouldFocusClose) this.querySelector(".file-viewer [data-act='close']")?.focus();
      return;
    }
    this.viewerOpen = false;
    const out = [];
    this.rows(store.state.files, 0, "", out);
    const targets = this.availableTargets();
    const selectedTarget = targets.includes(store.state.fileTarget) ? store.state.fileTarget : targets[0];
    if (store.state.fileTarget !== selectedTarget) store.state.fileTarget = selectedTarget;
    this.innerHTML = `<aside class="files">
      <div class="files-head">
        <div class="sec-label">Files</div>
        <button class="ghost-btn" data-act="close" title="Collapse">×</button>
      </div>
      <div class="file-target-row file-tree-target" role="group" aria-label="Diff target"><label for="file-target">Diff target</label><select id="file-target" class="file-target" aria-label="Diff target">${this.targetOptions(selectedTarget)}</select></div>
      ${store.state.fileError ? `<div class="file-error">${esc(store.state.fileError)}</div>` : ""}
      <div class="files-scroll">${out.length ? out.join("") : `<div class="file-empty">${store.state.filesLoading ? "Loading files…" : "No files found."}</div>`}</div>
    </aside>`;
    this.restoreScroll();
    this.focusFileTrigger();
  }
}

customElements.define("pi-files", PiFiles);
