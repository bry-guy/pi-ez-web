import { api, refreshState } from "./api.js";
import { beginOperation, completeOperation } from "./operations.js";
import { store } from "./store.js";
import { esc, selectSession } from "./shell.js";
import { gitErrorMessage, runningPickerOperation, pickerError, launchSetup, pickerOperationFeed, featureBranchForName } from "./panel-utils.js";


/* ---------------- branch/session picker ---------------- */
class PiSessionPicker extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("input", e => {
      const picker = store.state.sessionPicker;
      if (!picker) return;
      if (e.target.matches("[data-session-name]")) {
        picker.name = e.target.value;
        if ((picker.branch === "__new__" || !picker.branch) && (picker.newBranchAuto || !String(picker.newBranch || "").trim())) {
          picker.newBranch = featureBranchForName(picker.name);
          picker.newBranchAuto = !!picker.newBranch;
          const branchInput = this.querySelector("[data-session-new-branch]");
          if (branchInput) branchInput.value = picker.newBranch;
          this.syncActionState();
        }
      }
      if (e.target.matches("[data-session-new-branch]")) {
        picker.newBranch = e.target.value;
        picker.newBranchAuto = false;
        this.syncActionState();
      }
    });
    this.addEventListener("change", e => {
      const picker = store.state.sessionPicker;
      if (!picker) return;
      if (e.target.matches("[data-session-branch]")) picker.branch = e.target.value;
      if (e.target.matches("[data-session-base-branch]")) picker.baseBranch = e.target.value;
      store.notify("state");
    });
    this.render();
  }

  disconnectedCallback() { this.unsub?.(); }
  picker() { return store.state.sessionPicker; }
  project() { return store.state.projects.find(project => project.id === this.picker()?.projectId) || null; }
  flatten(nodes) { return (nodes || []).flatMap(node => [node, ...this.flatten(node.children)]); }

  close() { store.set({ sessionPicker: null, sessionPickerError: null }); }

  async selectBranch(branch) {
    const picker = this.picker();
    if (!picker) return;
    picker.branch = branch;
    picker.branchMenuOpen = false;
    if (branch === "__new__" && !String(picker.newBranch || "").trim()) {
      picker.newBranch = featureBranchForName(picker.name);
      picker.newBranchAuto = !!picker.newBranch;
    }
    store.notify("state");
    if (branch === "__new__") {
      queueMicrotask(() => this.querySelector("[data-session-new-branch]")?.focus());
      return;
    }
    if (picker.mode === "switch" && picker.sourceSessionId && branch !== picker.currentBranch) await this.submit("switch");
  }

  syncActionState() {
    const picker = this.picker();
    if (!picker || this.busy) return;
    const branch = picker.branch === "__new__" ? String(picker.newBranch || "").trim() : String(picker.branch || "").trim();
    const current = picker.currentBranch || "";
    for (const button of this.querySelectorAll("[data-act='create-session-context'], [data-act='apply-session-branch']")) {
      button.disabled = !branch || (button.dataset.mode && branch === current);
    }
  }

  detailFileCount(count, label) {
    return `${count} file${count === 1 ? "" : "s"} ${label}`;
  }

  sessionDetails(context, session = null) {
    if (!context && !session?.synchronized) return "";
    const rows = [];
    if (context) {
      const commit = context.commit || {};
      const hash = commit.shortHash || commit.hash?.slice(0, 8) || context.head?.slice(0, 8) || "Unavailable";
      const subject = String(commit.subject || "").split(/\r?\n/, 1)[0];
      const commitValue = subject ? `${hash} ${subject}` : hash;
      const details = context.statusDetails;
      const statusParts = [];
      if (details?.conflicts) statusParts.push(this.detailFileCount(details.conflicts, "conflicted"));
      if (details?.staged) statusParts.push(this.detailFileCount(details.staged, "staged"));
      if (details?.unstaged) statusParts.push(this.detailFileCount(details.unstaged, "unstaged"));
      if (details?.untracked) statusParts.push(this.detailFileCount(details.untracked, "untracked"));
      const tracking = [
        context.ahead ? `${context.ahead} ahead` : "",
        context.behind ? `${context.behind} behind` : "",
      ].filter(Boolean);
      const statusValue = statusParts.length
        ? [...statusParts, ...tracking].join(", ")
        : context.status === "clean"
          ? tracking.length ? `Clean, ${tracking.join(", ")}` : "Clean"
          : context.status === "unavailable"
            ? "Unavailable"
            : context.status || "Unknown";
      const kind = context.kind === "checkout" ? "checkout" : context.kind === "worktree" ? "worktree" : "unavailable";
      rows.push(
        ["Branch", context.branch || "Unavailable"],
        ["Commit", commitValue, commit.hash || context.head || ""],
        ["Workspace", `${kind} · ${context.path || "Unavailable"}`],
        ["Status", statusValue],
      );
    }
    if (session?.synchronized) {
      const state = { available: "Available", in_use: "In use", error: "Error" }[session.syncState] || session.syncState || "Unknown";
      const workspace = session.syncWorkspace;
      const upstream = workspace
        ? `${workspace.branch}@${String(workspace.commit || "").slice(0, 8)}`
        : "Unscoped";
      rows.push(["Sync", state]);
      rows.push(["Conversation", session.syncTitle && session.syncTitle !== session.syncSessionId ? session.syncTitle : "Untitled conversation"]);
      if (session.syncSessionId) rows.push(["Sync ID", session.syncSessionId, session.syncSessionId]);
      rows.push(["Upstream", upstream, workspace ? `${workspace.gitRemote} ${workspace.branch}@${workspace.commit}` : ""]);
      if (session.syncState === "in_use") {
        rows.push(["Lease", `${session.leaseHolder || "Active here"}${session.leaseExpiresAt ? ` · until ${session.leaseExpiresAt}` : ""}`]);
      }
      if (session.syncError?.message) rows.push(["Problem", session.syncError.message]);
    }
    return `<section class="session-details" aria-label="Session details"><div class="session-details-title">Session details</div><dl class="session-details-list">${rows.map(([key, value, title = ""]) => `<div class="session-detail-row"><dt>${esc(key)}</dt><dd${title ? ` title="${esc(title)}"` : ""}>${esc(value)}</dd></div>`).join("")}</dl></section>`;
  }

  async fetchBranches() {
    if (this.busy) return;
    const picker = this.picker();
    const project = this.project();
    const sessionId = picker?.sourceSessionId || null;
    if (!project || runningPickerOperation("fetch", sessionId)) return;
    this.busy = true;
    this.busyLabel = "Fetching…";
    const operation = beginOperation("fetch", "Fetch Git branches", "", "Request started.", sessionId, { projectId: project.id, action: "fetch" });
    store.set({ sessionPickerError: null });
    let result = null;
    try {
      result = await api.fetchProject(project.id, operation.id);
      await refreshState();
      completeOperation(operation, result);
    } catch (err) {
      completeOperation(operation, result || {}, err);
      pickerError(`Could not fetch branches: ${gitErrorMessage(err)}`, picker);
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async onClick(e) {
    const scrim = this.querySelector(".session-picker-scrim");
    if (e.target === scrim || e.target.closest("[data-act='close-session-picker']")) { this.close(); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "resume-session") {
      const project = this.project();
      const id = e.target.closest("[data-act]")?.dataset.id;
      if (project && id && !this.busy) {
        store.state.openTree[project.id] = true;
        selectSession(project.id, id, { showOperation: true });
      }
      return;
    }
    if (act === "toggle-branch-menu") {
      const picker = this.picker();
      if (!picker || this.busy) return;
      picker.branchMenuOpen = !picker.branchMenuOpen;
      store.notify("state");
      return;
    }
    if (act === "select-session-branch") {
      await this.selectBranch(e.target.closest("[data-act]").dataset.branch);
      return;
    }
    if (act === "fetch-branches") {
      await this.fetchBranches();
      return;
    }
    if (act === "create-session-context" || act === "apply-session-branch") { await this.submit(act === "apply-session-branch" ? e.target.closest("[data-act]").dataset.mode : "new"); return; }
    if (act === "run-hook") { void this.runHook(e.target.closest("[data-act]")?.dataset.hook); return; }
    if (act === "merge-branch") {
      const picker = this.picker(); const project = this.project();
      if (!picker || !project) return;
      const context = (project.contexts || []).find(item => item.branch === picker.currentBranch);
      const primaryBranch = project.defaultBranch || project.primaryBranch || "main";
      const confirm = { type: "merge", projectId: project.id, id: picker.sourceSessionId, branch: picker.currentBranch, primaryBranch, error: null, sessions: context?.sessions || [], dirty: context?.dirty ?? false, status: context?.status || "unknown" };
      this.close(); store.set({ confirm }); return;
    }
    if (act === "delete-branch") {
      const picker = this.picker(); const project = this.project();
      if (!picker || !project) return;
      const context = (project.contexts || []).find(item => item.branch === picker.currentBranch);
      const primaryBranch = project.defaultBranch || project.primaryBranch || "main";
      this.close();
      store.set({ confirm: { type: "deleteBranch", projectId: project.id, id: picker.sourceSessionId, branch: picker.currentBranch, primaryBranch, label: picker.currentBranch, sessions: context?.sessions || [], closeSessions: false, force: false, dirty: context?.dirty ?? false, status: context?.status || "unknown", error: null } });
      return;
    }
    if (act === "pull-branch") await this.pull();
    if (act === "push-branch") await this.push();
  }

  async submit(mode) {
    const picker = this.picker(); const project = this.project();
    if (!picker || !project || this.busy) return;
    const primary = project.defaultBranch || project.primaryBranch || "main";
    const enteredName = String(picker.name || "").trim();
    let branch = picker.branch === "__new__" ? String(picker.newBranch || "").trim() : String(picker.branch || "").trim();
    if (!branch && enteredName && (picker.branch === "__new__" || !picker.branch)) {
      branch = featureBranchForName(enteredName);
      picker.newBranch = branch;
      picker.newBranchAuto = !!branch;
    }
    if (!branch) { store.set({ sessionPickerError: "Enter a branch name or session name." }); return; }
    if (mode !== "new" && branch === picker.currentBranch) return;
    const baseBranch = picker.baseBranch || primary;
    const knownBranches = new Set([...(project.branches || []), ...(project.contexts || []).map(context => context.branch).filter(Boolean)]);
    const needsPrimaryFetch = !knownBranches.has(branch) && baseBranch === primary;
    this.busy = true;
    this.busyLabel = needsPrimaryFetch ? `Fetching ${primary}…` : mode === "new" ? "Creating session…" : mode === "switch" ? "Switching…" : "Forking…";
    store.set({ sessionPickerError: null });
    const operation = beginOperation(
      mode === "new" ? "create-session" : mode === "switch" ? "switch-session" : "fork-session",
      mode === "new" ? "Create session" : mode === "switch" ? "Switch session" : "Fork session",
      "",
      needsPrimaryFetch ? `Waiting for ${primary} preparation…` : "Request started.",
      picker.sourceSessionId,
    );
    let result = null;
    try {
      const body = { branch, baseBranch, operationId: operation.id, ...(mode === "new" || enteredName ? { name: enteredName || null } : {}) };
      result = mode === "new"
        ? await api.newProjectSession(project.id, body)
        : await api.branchSession(picker.sourceSessionId, { ...body, mode });
      if (result?.id && mode === "new" && !store.findSession(result.id, project.sessions)) {
        const context = (project.contexts || []).find(item => item.branch === (result.branch || branch));
        project.sessions.unshift({ id: result.id, title: body.name || "New session", contextId: result.contextId || context?.id || null, branch: result.branch || branch, workspacePath: result.workspacePath || context?.path || null, model: store.state.effectiveDefaultModel, when: "now", updatedAt: new Date().toISOString(), activityAt: new Date().toISOString(), streaming: false, children: [] });
        store.notify("state");
      }
      const targetId = result?.id || picker.sourceSessionId;
      if (!targetId) throw new Error("The server did not return a session id.");
      operation.sessionId = targetId;
      completeOperation(operation, result);
      store.set({ sessionPicker: null, sessionPickerError: null });
      store.state.openTree[project.id] = true;
      selectSession(project.id, targetId);
      launchSetup(targetId, result);
      void refreshState().catch(err => store.setError(`Could not refresh session state: ${err.message || err}`));
    } catch (err) {
      const messages = {
        no_such_base_branch: "That base branch no longer exists.",
        session_streaming: "Wait for the current response to finish before switching.",
        same_branch: "Choose a different branch.",
      };
      const displayError = Object.assign(new Error(messages[err.error] || gitErrorMessage(err)), err);
      completeOperation(operation, result || {}, displayError);
      pickerError(messages[err.error] || gitErrorMessage(err), picker);
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async pull() {
    const id = this.picker()?.sourceSessionId;
    if (!id || this.busy) return;
    this.busy = true;
    this.busyLabel = "Pulling…";
    const operation = beginOperation("pull", "Pull", "", "Request started.");
    let result = null;
    try {
      result = await api.pullBranch(id);
      completeOperation(operation, result);
      void refreshState().catch(err => store.setError(`Could not refresh branch state: ${err.message || err}`));
    } catch (err) {
      completeOperation(operation, result || {}, err);
      store.set({ sessionPickerError: gitErrorMessage(err) });
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async push() {
    const id = this.picker()?.sourceSessionId;
    const project = this.project();
    if (!id || !project || this.busy || runningPickerOperation("push-preview", id)) return;
    this.busy = true;
    this.busyLabel = "Checking commits to push…";
    const operation = beginOperation("push-preview", "Review push", "", "Checking commits to push…", id);
    try {
      const preview = await api.pushPreview(id);
      completeOperation(operation, { ok: true, httpStatus: 200, stdout: `${preview.commitCount} commit${preview.commitCount === 1 ? "" : "s"} ready to push.` });
      this.close();
      store.set({ confirm: { type: "push", projectId: project.id, id, branch: preview.branch, upstream: preview.upstream, commits: preview.commits || [], commitCount: preview.commitCount || 0, head: preview.head, baseHead: preview.baseHead, error: null } });
    } catch (err) {
      completeOperation(operation, {}, err);
      store.set({ sessionPickerError: gitErrorMessage(err) });
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async runHook(name) {
    const picker = this.picker();
    const id = picker?.sourceSessionId;
    const title = name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Hook";
    if (!id || !name || runningPickerOperation("hook", id, title)) return;
    const operation = beginOperation("hook", title, "", "Request started.", id);
    let result = null;
    try {
      result = await api.hook(id, name, operation.id);
      completeOperation(operation, result);
      void refreshState().catch(err => pickerError(`Could not refresh hook state: ${err.message || err}`, picker));
    } catch (err) {
      completeOperation(operation, result || {}, err);
      pickerError(`${title} failed: ${err.error || err.message || err}`, picker);
    } finally { this.render(); }
  }

  render() {
    const picker = this.picker();
    if (!picker) { this.innerHTML = ""; return; }
    const project = this.project();
    if (!project) { this.innerHTML = ""; return; }
    const focused = document.activeElement;
    const focusSelector = focused && this.contains(focused) && focused.matches("[data-session-name], [data-session-new-branch], [data-session-base-branch]")
      ? (focused.matches("[data-session-name]") ? "[data-session-name]" : focused.matches("[data-session-new-branch]") ? "[data-session-new-branch]" : "[data-session-base-branch]")
      : null;
    const selectionStart = focused?.selectionStart;
    const selectionEnd = focused?.selectionEnd;
    const contexts = project.contexts || [];
    const primary = project.defaultBranch || project.primaryBranch || contexts.find(context => context.primaryBranch)?.primaryBranch || "main";
    const contextFor = branch => contexts.find(context => context.branch === branch) || null;
    const branches = [...new Set([primary, ...(project.branches || []), ...contexts.map(context => context.branch).filter(Boolean)])]
      .sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)));
    const mode = picker.mode === "new" ? "new" : picker.mode;
    const selected = picker.branch || (mode === "new" ? primary : picker.currentBranch || project.branch || primary);
    const isNew = selected === "__new__";
    const effectiveBranch = isNew ? String(picker.newBranch || "").trim() : selected;
    const different = !!effectiveBranch && effectiveBranch !== picker.currentBranch;
    const context = contextFor(effectiveBranch);
    const users = context?.sessions || [];
    const sourceSession = picker.sourceSessionId ? this.flatten(project.sessions).find(session => session.id === picker.sourceSessionId) : null;
    const userText = users.length ? users.map(user => `<span class="session-context-user ${user.streaming ? "working" : ""}"><i></i>${esc(user.title)} · ${user.streaming ? "working" : "idle"}</span>`).join("") : "No other sessions are using this branch.";
    const branchMeta = branch => {
      const item = contextFor(branch);
      if (!item) return "not checked out";
      return `${item.kind === "checkout" ? "CHECKOUT" : "WORKTREE"} · ${item.status || (item.dirty ? "dirty" : "clean")}`;
    };
    const branchButton = branch => `<button type="button" class="branch-option" data-act="select-session-branch" data-branch="${esc(branch)}" role="option" aria-selected="${selected === branch}"><span class="branch-option-name">${esc(branch)}</span><span class="branch-option-meta">${esc(branchMeta(branch))}</span></button>`;
    const selectedBranchLabel = isNew ? "＋ New branch…" : selected;
    const branchMenu = picker.branchMenuOpen ? `<div class="branch-picker-menu" role="listbox" aria-label="Branches"><div class="branch-picker-menu-head"><span>Branches</span><span>${branches.length} available</span></div><div class="branch-picker-scroll" aria-label="Branches">${branches.map(branchButton).join("")}</div><button type="button" class="branch-new-option" data-act="select-session-branch" data-branch="__new__">＋ New branch…</button></div>` : "";
    const branchField = `<div class="branch-picker"><button type="button" class="branch-picker-trigger" data-act="toggle-branch-menu" aria-expanded="${!!picker.branchMenuOpen}" aria-haspopup="listbox"><span>${esc(selectedBranchLabel)}</span><span class="branch-picker-caret">${picker.branchMenuOpen ? "⌃" : "⌄"}</span></button>${branchMenu}</div>`;
    const sessionDetails = this.sessionDetails(context, sourceSession);
    const baseOptions = branches.map(branch => `<option value="${esc(branch)}" ${(picker.baseBranch || primary) === branch ? "selected" : ""}>${esc(branch)}</option>`).join("");
    const existing = mode !== "new";
    const current = picker.currentBranch || "";
    const primarySelected = current === primary;
    const actionButtons = existing
      ? `<button class="settings-save" data-act="apply-session-branch" data-mode="fork" ${this.busy || !different ? "disabled" : ""}>Fork</button>`
      : `<button class="settings-save" data-act="create-session-context" ${this.busy || !effectiveBranch ? "disabled" : ""}>${this.busy ? esc(this.busyLabel || "Creating…") : "Create session"}</button>`;
    const primaryReason = `Unavailable for ${primary}; ${primary} is the primary checkout.`;
    const fetchRunning = !!runningPickerOperation("fetch", picker.sourceSessionId);
    const fetchButton = `<button class="settings-action" data-act="fetch-branches" title="Fetch remote Git branches" aria-label="Fetch remote Git branches" ${this.busy || fetchRunning ? "disabled" : ""}>${this.busy && this.busyLabel === "Fetching…" ? "Fetching…" : "Fetch"}</button>`;
    const branchButtons = existing && current && effectiveBranch === current ? `<button class="settings-action" data-act="merge-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : `Merge to ${esc(primary)}`}">Merge to ${esc(primary)}</button><button class="settings-action" data-act="pull-branch" ${this.busy ? "disabled" : ""}>Pull</button><button class="settings-action" data-act="push-branch" ${this.busy ? "disabled" : ""}>${this.busy && this.busyLabel === "Checking commits to push…" ? esc(this.busyLabel) : "Push"}</button><button class="settings-action danger-outline" data-act="delete-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : "Delete local branch"}">Delete</button>` : "";
    const branchActions = `<section class="session-branch-actions"><div class="session-context-heading"><span>Git</span></div><div class="session-context-users branch-user-list">${userText}</div><div class="workspace-actions">${fetchButton}${branchButtons}</div></section>`;
    const hookNames = existing && picker.sourceSessionId ? Object.entries(project.hooks || {}).filter(([name, enabled]) => enabled && name).map(([name]) => name) : [];
    const hookLabel = name => name ? `${name[0].toUpperCase()}${name.slice(1)}` : name;
    const hookButtons = hookNames.map(name => {
      const label = hookLabel(name);
      const running = !!runningPickerOperation("hook", picker.sourceSessionId, label);
      return `<button class="settings-action" data-act="run-hook" data-hook="${esc(name)}" ${running ? "disabled" : ""}>${esc(running ? `${label}ing…` : label)}</button>`;
    }).join("");
    const sessionActions = `<section class="session-picker-actions"><div class="session-context-heading session-picker-actions-heading"><span>Session</span></div><div class="workspace-actions session-picker-session-buttons">${hookButtons}${actionButtons}</div></section>`;
    const historySessions = mode === "new" ? this.flatten(project.sessions) : [];
    const historyRows = historySessions.map(session => {
      const sessionBranch = session.branch || contexts.find(item => item.id === session.contextId)?.branch || primary;
      return `<button type="button" class="session-history-row" data-act="resume-session" data-id="${esc(session.id)}" aria-label="Resume ${esc(session.title || "Untitled session")}"><span class="session-history-main"><strong>${esc(session.title || "Untitled session")}</strong><small>${esc(sessionBranch)}${session.when ? ` · ${esc(session.when)}` : ""}</small></span><span class="session-history-resume">Resume</span></button>`;
    }).join("");
    const historySection = mode === "new" ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>History</span><span>${historySessions.length} session${historySessions.length === 1 ? "" : "s"}</span></div><div class="session-history-scroll">${historyRows || `<div class="session-history-empty">No previous sessions yet.</div>`}</div></section>` : "";
    const error = store.state.sessionPickerError ? `<div class="session-picker-error">${esc(store.state.sessionPickerError)}</div>` : "";
    const progress = this.busy ? `<div class="session-picker-progress" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${esc(this.busyLabel || "Working…")}</span></div>` : "";
    const operationProgress = pickerOperationFeed(picker);
    const subtitle = existing ? `${esc(project.name)} · choose a branch or fork this conversation` : `${esc(project.name)} · choose a branch for this conversation`;
    this.innerHTML = `<div class="session-picker-scrim"><section class="session-picker" role="dialog" aria-label="${existing ? "Session" : "New session"}"><div class="session-picker-head"><div><div class="modal-title">${existing ? "Session" : "New session"}</div><div class="session-picker-subtitle">${subtitle}</div></div><button class="ghost-btn" data-act="close-session-picker" aria-label="Close">×</button></div><div class="session-picker-body" aria-busy="${!!this.busy}"><label class="session-picker-source"><span>Name</span><input class="session-name-input" data-session-name value="${esc(picker.name || "")}" placeholder="Autonamed if empty" autocomplete="off"></label><label class="session-picker-source"><span>Branch</span>${branchField}</label>${sessionDetails}${isNew ? `<label class="session-picker-source"><span>New branch name</span><input class="session-branch-input" data-session-new-branch value="${esc(picker.newBranch || "")}" placeholder="feature/my-change" autocomplete="off"></label><label class="session-picker-source"><span>Based on</span><select data-session-base-branch>${baseOptions}</select></label><div class="session-picker-help">Non-${esc(primary)} branches use worktrees.</div>` : ""}${historySection}${progress}${error}${branchActions}${sessionActions}${operationProgress}</div></section></div>`;
    const feed = this.querySelector(".session-operation-feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
    if (focusSelector) {
      const next = this.querySelector(focusSelector);
      if (next) {
        next.focus({ preventScroll: true });
        if (selectionStart != null && typeof next.setSelectionRange === "function") next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
      }
    }
  }
}

customElements.define("pi-session-picker", PiSessionPicker);
