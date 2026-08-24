import { api, refreshState } from "./api.js";
import { beginOperation, combineOperationResults, completeOperation, operationFor, operationHint, showCompletedOperation } from "./operations.js";
import { store } from "./store.js";
import { esc, mobile, openSessionPicker, selectSession } from "./shell.js";

const gitErrorMessage = error => ({
  bad_branch: "Enter a valid Git branch name.",
  no_such_context: "That Git context is no longer available.",
  no_project_for_session: "This session is no longer attached to a project.",
  checkout_dirty: "The primary checkout has uncommitted changes.",
  workspace_dirty: "Clean this workspace before continuing.",
  git_status_unavailable: "Git status is unavailable; check the workspace and try again.",
  main_worktree_external: "The primary branch is checked out by another worktree.",
  main_fetch_failed: "Could not fetch the primary branch's upstream.",
  main_not_fast_forwardable: "The primary branch has diverged; reconcile it before continuing.",
  git_switch_failed: "Git could not switch the checkout.",
  merge_conflict: "Git reported a merge conflict; the merge was aborted.",
  git_push_failed: "Git could not push this branch.",
  push_preview_failed: "The commits to push could not be listed.",
  push_preview_stale: "The branch changed; review the commits to push again.",
  detached_head: "This workspace is detached and has no branch to push.",
  branch_delete_failed: "Git could not delete this branch.",
  sessions_active: "Stop active sessions before changing this branch.",
  sync_workspace_in_use: "A synchronized conversation is using this branch.",
  merge_rehome_failed: "The merge landed, but sessions could not return to the primary branch.",
  merge_cleanup_failed: "The merge landed, but the source branch could not be removed.",
}[error?.error] || error?.detail || error?.message || error?.error || "Git operation failed.");

function operationFeedback(kinds, fallback = "Working…") {
  const operation = operationFor(kinds);
  if (!operation) return "";
  const status = operation.status === "error" ? "error" : operation.status === "success" ? "success" : "running";
  const dot = status === "running" ? `<i class="operation-dot" aria-hidden="true"></i>` : `<i class="operation-state-dot" aria-hidden="true"></i>`;
  return `<span class="operation-hint ${status}" data-operation-hint="${esc(operation.kind)}">${dot}<span>${esc(operationHint(operation, fallback))}</span></span>`;
}

const syncErrorMessage = error => ({
  sync_not_configured: "Configure a sync server in Settings first.",
  sync_client_unavailable: "The pi-sync client is not installed on this server yet.",
  sync_unavailable: "The synchronization service is temporarily unavailable.",
  sync_duplicate: "This conversation already has a canonical synchronized copy.",
  active_lease: error?.details?.holder
    ? `This conversation is in use by ${error.details.holder}.`
    : "This conversation is in use by another client.",
  sync_conflict: "The canonical conversation changed elsewhere; the local copy was preserved.",
  sync_lease_uncertain: "The synchronization lease could not be verified. Try again after the service recovers.",
  sync_session_not_found: "The sync server no longer has this conversation.",
  sync_workspace_setup_required: error?.message || "Prepare the recorded Git workspace before continuing.",
  session_streaming: "Stop the current response before synchronizing this conversation.",
  session_compacting: "Wait for compaction to finish before synchronizing this conversation.",
}[error?.error] || error?.message || error?.error || "Could not synchronize this conversation.");

function featureBranchForName(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug ? `feature/${slug}` : "";
}

/* ---------------- settings ---------------- */
class PiSettings extends HTMLElement {
  connectedCallback() {
    this.feedback = null;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("change", e => {
      if (e.target.matches("[data-setting='defaultThinkingLevel']")) void this.saveDefaultThinking(e.target.value);
    });
    this.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches(".repos-root-input")) {
        e.preventDefault();
        this.saveReposRoot();
      }
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    clearTimeout(this.flowTimer);
    clearTimeout(this.feedbackTimer);
  }
  setFeedback(message, kind = "success") {
    this.feedback = { message, kind };
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedback = null;
      this.render();
    }, 3500);
    this.render();
  }
  async onClick(e) {
    if (e.target.closest("[data-act='open-logs']")) { store.set({ logsOpen: true, logsError: null }); return; }
    if (e.target.closest("[data-act='save-repos-root']")) return this.saveReposRoot();
    if (e.target.closest("[data-act='save-repository-settings']")) return this.saveRepositorySettings();
    if (e.target.closest("[data-act='save-sync-settings']")) return this.saveSyncSettings();
    if (e.target.closest("[data-act='save-pi-configuration']")) return this.savePiConfiguration();
    if (e.target.closest("[data-act='refresh-pi-configuration']")) return this.refreshPiConfiguration();
    if (e.target.closest("[data-act='open-github-picker']")) return this.openGithubPicker();
    if (e.target.closest("[data-github-logout]")) return this.logoutGithub();
    const login = e.target.closest("[data-auth-login]");
    if (login) return this.startAuth(login.dataset.authLogin, login.dataset.authType);
    const logout = e.target.closest("[data-auth-logout]");
    if (logout) return this.logoutProvider(logout.dataset.authLogout);
    if (e.target.closest("[data-auth-cancel]")) return this.cancelAuth();
    if (e.target.closest("[data-auth-submit]")) return this.submitAuth();
  }
  async saveReposRoot() {
    const input = this.querySelector(".repos-root-input");
    if (!input) return;
    const value = input.value.trim() || null;
    const previous = store.state.reposRoot;
    try {
      const result = await api.settings(undefined, value);
      store.set({ reposRoot: result.reposRoot || null, reposRootSource: result.reposRootSource || "default", repos: [] });
      this.setFeedback("Repository path saved.");
    } catch (err) {
      store.set({ reposRoot: previous });
      this.setFeedback(`Repository path failed: ${err.error || err.message || err}`, "error");
    }
  }
  async saveDefaultThinking(level) {
    const previous = store.state.defaultThinkingLevel;
    try {
      const result = await api.settingsPatch({ defaultThinkingLevel: level });
      store.set({ defaultThinkingLevel: result.defaultThinkingLevel || level });
      this.setFeedback("Default thinking mode saved.");
    } catch (err) {
      store.set({ defaultThinkingLevel: previous });
      this.setFeedback(`Default thinking mode failed: ${err.error || err.message || err}`, "error");
    }
  }
  async saveSyncSettings() {
    const syncSettings = store.state.settings?.sync || {};
    const patch = { sync: {} };
    if (syncSettings.serverUrl?.editable !== false) patch.sync.serverUrl = this.querySelector("[data-setting='syncServerUrl']")?.value.trim() || null;
    if (syncSettings.allConversations?.editable !== false) patch.sync.allConversations = !!this.querySelector("[data-setting='syncAllConversations']")?.checked;
    if (!Object.keys(patch.sync).length) return;
    try {
      await api.settingsPatch(patch);
      await refreshState();
      this.setFeedback("Synchronization settings saved.");
    } catch (err) {
      const message = err.error === "setting_overridden"
        ? "One or more synchronization settings are deployment-controlled."
        : err.error === "sync_active"
          ? "Finish the active synchronized operation before changing the sync server."
          : `Synchronization settings failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async saveRepositorySettings() {
    const patch = {};
    if (store.state.settings?.defaultRepositorySource?.editable !== false) patch.defaultRepositorySource = this.querySelector("[data-setting='defaultRepositorySource']")?.value;
    if (store.state.settings?.githubOwner?.editable !== false) patch.githubOwner = this.querySelector("[data-setting='githubOwner']")?.value.trim() || null;
    if (!Object.keys(patch).length) return;
    const autoProfile = patch.githubOwner !== undefined && store.state.piConfiguration?.config?.profileSource === "auto";
    const operation = autoProfile ? beginOperation("repository-settings", "Load GitHub dotfiles", "", "Request started.") : null;
    try {
      const result = await api.settingsPatch({ ...patch, ...(operation ? { operationId: operation.id, activeSessionId: store.activeKey() } : {}) });
      if (operation) completeOperation(operation, result);
      await refreshState();
      this.setFeedback("Repository settings saved.");
    } catch (err) {
      if (operation) completeOperation(operation, {}, err);
      const message = err.error === "invalid_github_owner"
        ? "Enter a valid GitHub user or organization name."
        : `Repository settings failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async savePiConfiguration() {
    const lines = selector => (this.querySelector(selector)?.value || "")
      .split("\n").map(value => value.trim()).filter(Boolean);
    const current = store.state.piConfiguration?.config || {};
    const profile = this.querySelector("[data-setting='piProfile']")?.value.trim() || null;
    const pi = {
      profile,
      profileSource: current.profileSource === "auto" && profile === (current.profile || "")
        ? "auto"
        : profile ? "explicit" : "disabled",
      packages: lines("[data-setting='piPackages']"),
      extensions: lines("[data-setting='piExtensions']"),
    };
    await this.applyPiConfiguration(pi, "saved");
  }
  async refreshPiConfiguration() {
    const pi = store.state.piConfiguration?.config;
    if (!pi) return;
    await this.applyPiConfiguration(pi, "refreshed");
  }
  async applyPiConfiguration(pi, verb) {
    const operation = beginOperation("pi-profile", verb === "refreshed" ? "Refresh Pi resources" : "Reload Pi resources", "", "Request started.");
    try {
      const result = await api.settingsPatch({ pi, operationId: operation.id, activeSessionId: store.activeKey() });
      completeOperation(operation, result);
      void refreshState().catch(err => store.setError(`Could not refresh Pi resource state: ${err.message || err}`));
      const profileError = result.piConfiguration?.profile?.error;
      const message = profileError
        ? `Pi configuration ${verb}, but the profile could not be loaded: ${profileError}`
        : `Pi profile ${verb}. Packages and skills reload when a session loads.`;
      this.setFeedback(message, profileError ? "error" : "success");
    } catch (err) {
      completeOperation(operation, {}, err);
      const message = err.error === "pi_configuration_busy"
        ? "Stop active sessions before changing Pi extensions."
        : `Pi configuration failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async startAuth(providerId, type) {
    if (this.flow) return;
    try {
      const result = await api.authStart(providerId, type);
      this.flow = result.flow;
      this.render();
      void this.pollAuth(this.flow.id);
    } catch (err) {
      store.setError(`Provider login failed: ${err.error || err.message || err}`);
    }
  }
  async pollAuth(id) {
    clearTimeout(this.flowTimer);
    try {
      const result = await api.authFlow(id);
      if (!this.flow || this.flow.id !== id) return;
      this.flow = result.flow;
      this.render();
      if (this.flow.state === "complete") {
        this.flow = null;
        await refreshState();
        store.setError("Provider connected.", 2200);
        return;
      }
      if (["error", "cancelled"].includes(this.flow.state)) {
        const message = this.flow.error?.message || "Provider login did not complete.";
        this.flow = null;
        store.setError(message);
        return;
      }
      this.flowTimer = setTimeout(() => this.pollAuth(id), 1000);
    } catch (err) {
      this.flow = null;
      store.setError(`Provider login status failed: ${err.error || err.message || err}`);
    }
  }
  async submitAuth() {
    const prompt = this.flow?.prompt;
    if (!this.flow || !prompt) return;
    const input = this.querySelector("[data-auth-input]");
    const value = input?.value || "";
    if (input && prompt.type === "secret") input.value = "";
    try {
      const result = await api.authInput(this.flow.id, prompt.id, value);
      this.flow = result.flow;
      this.render();
    } catch (err) {
      store.setError(`Provider input failed: ${err.error || err.message || err}`);
    }
  }
  async cancelAuth() {
    const id = this.flow?.id;
    if (!id) return;
    clearTimeout(this.flowTimer);
    try { await api.authCancel(id); } catch { /* terminal cancellation is best effort */ }
    this.flow = null;
    this.render();
  }
  async logoutProvider(providerId) {
    try {
      await api.providerLogout(providerId);
      await refreshState();
      store.setError("Provider disconnected.", 2200);
    } catch (err) {
      store.setError(`Provider logout failed: ${err.error || err.message || err}`);
    }
  }
  openGithubPicker() {
    const github = store.state.repositorySources?.sources?.find(source => source.id === "github");
    store.set({ repoPickerOpen: true, repoPickerSource: "github" });
    // A Settings action labelled “Sign in” must actually begin sign-in. The
    // picker owns the Device Flow display and polling, so defer until it has
    // rendered in its GitHub source state.
    if (github?.configured && !github.authenticated) {
      queueMicrotask(() => { void document.querySelector("pi-repo-picker")?.startGithubLogin(); });
    }
  }
  async logoutGithub() {
    try {
      await api.githubLogout();
      await refreshState();
      store.setError("GitHub disconnected.", 2200);
    } catch (err) {
      store.setError(`GitHub disconnect failed: ${err.error || err.message || err}`);
    }
  }
  providerCard(provider) {
    if (provider.id === "openai" && !provider.configured) return "";
    const status = provider.configured
      ? `Connected${provider.sourceLabel ? ` · ${provider.sourceLabel}` : ""}`
      : "Not connected";
    const login = provider.source === "environment" ? "" : provider.authMethods?.map(method => {
      const label = provider.id === "openai-codex" && method.id === "oauth"
        ? "Sign in with ChatGPT"
        : provider.id === "anthropic" && method.id === "oauth"
          ? "Sign in with Anthropic"
          : method.id === "api_key"
            ? `Use ${provider.name} API key`
            : method.label;
      return `
      <button class="settings-action" data-auth-login="${esc(provider.id)}" data-auth-type="${esc(method.id)}">
        ${esc(provider.configured ? `Reconnect · ${label}` : label)}
      </button>`;
    }).join("") || "";
    const logout = provider.canLogout
      ? `<button class="settings-action quiet" data-auth-logout="${esc(provider.id)}">Disconnect</button>` : "";
    return `<div class="settings-card provider-card">
      <div class="provider-card-head">
        <div><div class="sr-title">${esc(provider.name)}</div><div class="sr-sub">${esc(status)} · ${provider.availableModels || 0} available model${provider.availableModels === 1 ? "" : "s"}</div></div>
        <span class="status-dot ${provider.configured ? "" : "off"}"></span>
      </div>
      ${provider.error ? `<div class="provider-error">${esc(provider.error.message || "Provider status unavailable.")}</div>` : ""}
      <div class="provider-actions">${login}${logout}</div>
    </div>`;
  }
  authFlowCard() {
    const flow = this.flow;
    if (!flow) return "";
    const note = flow.notification;
    let notification = "";
    if (note?.type === "auth_url") notification = `<div class="auth-note">${esc(note.instructions || "Complete login in your browser.")} <a href="${esc(note.url)}" target="_blank" rel="noopener">Open authorization page</a></div>`;
    else if (note?.type === "device_code") notification = `<div class="auth-device"><div>Open <a href="${esc(note.verificationUri)}" target="_blank" rel="noopener">${esc(note.verificationUri)}</a></div><strong>${esc(note.userCode)}</strong><div class="auth-note">The server will finish after you approve this device.</div></div>`;
    else if (note?.message) notification = `<div class="auth-note">${esc(note.message)}</div>`;
    let prompt = "";
    if (flow.prompt?.type === "select") prompt = `<select data-auth-input aria-label="${esc(flow.prompt.message)}">${(flow.prompt.options || []).map(option => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join("")}</select>`;
    else if (flow.prompt) prompt = `<input data-auth-input type="${flow.prompt.type === "secret" ? "password" : "text"}" placeholder="${esc(flow.prompt.placeholder || "")}" aria-label="${esc(flow.prompt.message)}">`;
    return `<div class="auth-flow-card" role="dialog" aria-label="Provider login">
      <div class="auth-flow-head"><strong>Provider login</strong><button class="ghost-btn" data-auth-cancel aria-label="Cancel login">×</button></div>
      ${notification}
      ${flow.prompt ? `<div class="auth-prompt"><label>${esc(flow.prompt.message)}</label>${prompt}<button class="settings-save" data-auth-submit>Submit</button></div>` : ""}
      ${flow.state === "pending" ? `<div class="auth-note">Waiting for provider…</div>` : ""}
      ${flow.error ? `<div class="provider-error">${esc(flow.error.message)}</div>` : ""}
    </div>`;
  }
  render() {
    const providers = (store.state.providers || []).filter(provider => provider.id !== "openai" || provider.configured);
    const settings = store.state.settings || {};
    const syncState = store.state.sync || {};
    const syncSettings = settings.sync || {};
    const syncServerUrl = syncSettings.serverUrl?.value || "";
    const syncServerEditable = syncSettings.serverUrl?.editable !== false;
    const syncAll = !!syncSettings.allConversations?.value;
    const syncAllEditable = syncSettings.allConversations?.editable !== false;
    const syncLabel = !syncState.configured
      ? "Not configured"
      : syncState.connection === "available"
        ? "Connected"
        : syncState.connection === "disabled"
          ? "Disabled"
          : "Sync client unavailable";
    const source = settings.defaultRepositorySource?.value || store.state.repositorySources?.default || "local";
    const sourceEditable = settings.defaultRepositorySource?.editable !== false;
    const owner = settings.githubOwner?.value || "";
    const ownerEditable = settings.githubOwner?.editable !== false;
    const githubStatus = store.state.repositorySources?.sources?.find(source => source.id === "github");
    const piState = store.state.piConfiguration || {};
    const piConfig = piState.config || { profile: null, packages: [], extensions: [] };
    const profileStatus = ["loaded", "cached"].includes(piState.profile?.status)
      ? `${piState.profile.status === "cached" ? "Using cached" : "Loaded"} ${piState.profile.source}${piState.profile.ref ? ` @ ${piState.profile.ref}` : ""}${piState.profile.commit ? ` · ${piState.profile.commit.slice(0, 12)}` : ""}`
      : piState.profile?.status === "error"
        ? `Profile error: ${piState.profile.error}`
        : piConfig.profileSource === "auto"
          ? "Automatic GitHub dotfiles profile"
          : "Using the deployment's Pi settings";
    const loadedExtensions = Array.isArray(piState.runtime?.extensions) ? piState.runtime.extensions : [];
    const loadedSkills = Array.isArray(piState.runtime?.skills) ? piState.runtime.skills : [];
    const resourceRows = (items, empty) => items.length
      ? `<ul>${items.map(item => `<li><strong>${esc(item.name || "Unnamed resource")}</strong><span>${esc(item.path || "")}</span><small>${esc([item.source, item.scope, item.origin].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul>`
      : `<div class="pi-resource-empty">${esc(empty)}</div>`;
    const extensionList = piState.runtime
      ? `<details class="pi-loaded-list"><summary>Loaded extensions (${loadedExtensions.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedExtensions, "No extensions loaded.")}</div></details>`
      : "";
    const skillList = piState.runtime
      ? `<details class="pi-loaded-list"><summary>Loaded skills (${loadedSkills.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedSkills, "No skills loaded.")}</div></details>`
      : "";
    const skillCount = Array.isArray(piState.runtime?.skills) ? loadedSkills.length : (piState.runtime?.skills || 0);
    const runtimeSummary = piState.runtime
      ? `${loadedExtensions.length} extension${loadedExtensions.length === 1 ? "" : "s"}, ${skillCount} skill${skillCount === 1 ? "" : "s"}, and ${piState.runtime.prompts || 0} prompts loaded${piState.runtime.loadedAt ? ` at ${new Date(piState.runtime.loadedAt).toLocaleTimeString()}` : ""}.`
      : "Resources load when a session runtime is attached.";
    const piProblems = [
      ...(piState.warnings || []),
      ...(piState.runtime?.errors || []).map(error => `${error.path}: ${error.error}`),
      ...(piState.runtime?.skillDiagnostics || []).map(error => `${error.path || "skill"}: ${error.message}`),
    ];
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const defaultThinkingLevel = store.state.defaultThinkingLevel || "medium";
    const feedback = this.feedback
      ? `<div class="settings-feedback ${this.feedback.kind === "error" ? "error" : ""}" role="status">${esc(this.feedback.message)}</div>`
      : "";
    const piOperation = operationFeedback("pi-profile", "Reloading Pi resources…");
    const repositoryOperation = operationFeedback("repository-settings", "Saving repository settings…");
    const githubSummary = githubStatus?.authenticated
      ? `Connected${githubStatus.account?.login ? ` as ${githubStatus.account.login}` : ""}`
      : githubStatus?.configured ? "Not connected" : "Sign-in requires server GitHub app setup";
    this.innerHTML = `<div class="col-pad">
      <div class="screen-title-row"><div class="screen-title">Settings</div><button class="settings-action quiet" data-act="open-logs">Logs</button></div>
      ${feedback}
      <section class="settings-section">
        <div class="settings-section-title">AI providers</div>
        <div class="provider-list">${providers.map(provider => this.providerCard(provider)).join("") || `<div class="modal-empty">No provider status available.</div>`}</div>
      </section>
      ${this.authFlowCard()}
      <section class="settings-section">
        <div class="settings-section-title">Pi profile & extensions</div>
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Profile settings</div><div class="sr-sub">Leave this automatic to use the configured GitHub user's <span class="settings-mono">dotfiles</span> repository. Explicit paths and HTTPS URLs override it. GitHub profiles read <span class="settings-mono">.pi/agent/settings.json</span> and trusted resources.</div></div>
            <input class="settings-inline-input pi-profile-input" data-setting="piProfile" value="${esc(piConfig.profile || "")}" placeholder="https://github.com/owner/dotfiles">
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Additional packages</div><div class="sr-sub">One Pi npm/git package source per line. Pi installs missing packages automatically.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piPackages" rows="4" placeholder="npm:context-mode&#10;git:github.com/owner/pi-extension">${esc((piConfig.packages || []).join("\n"))}</textarea>
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Additional extensions</div><div class="sr-sub">One package source or server-local extension path per line. Relative paths resolve from <span class="settings-mono">PI_WEB_HOME</span>.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piExtensions" rows="4" placeholder="/data/extensions/my-extension.ts">${esc((piConfig.extensions || []).join("\n"))}</textarea>
          </div>
          <div class="settings-row pi-resource-status"><div class="sr-main"><div class="sr-title">${esc(profileStatus)}</div><div class="sr-sub">${esc(runtimeSummary)}</div>${extensionList}${skillList}${piProblems.length ? `<div class="provider-error">${piProblems.map(esc).join(" · ")}</div>` : ""}</div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">Remote extensions execute with the server user's full permissions.</span><div class="settings-actions"><button class="settings-action quiet" data-act="refresh-pi-configuration">Refresh profile</button><button class="settings-save" data-act="save-pi-configuration">Save & reload</button>${piOperation}</div></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Conversation synchronization</div>
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Sync server</div><div class="sr-sub">Canonical enrolled conversations live in the configured pi-sync service. Leave this empty to keep local-only behavior.</div></div>
            <input class="settings-inline-input" data-setting="syncServerUrl" value="${esc(syncServerUrl)}" placeholder="https://pi-sync.example${syncServerEditable ? "" : " (deployment controlled)"}" ${syncServerEditable ? "" : "disabled"}>
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Synchronize all conversations</div><div class="sr-sub">Records the deployment-wide preference for the reconciliation pass. Individual conversations can be enrolled now.</div></div>
            <label class="sync-toggle"><input type="checkbox" data-setting="syncAllConversations" ${syncAll ? "checked" : ""} ${syncAllEditable ? "" : "disabled"}><span>${syncAll ? "On" : "Off"}</span></label>
          </div>
          <div class="settings-row"><div class="sr-main"><div class="sr-title">${esc(syncLabel)}</div><div class="sr-sub">${syncState.implementation === "fake" ? "Using the development coordinator; no network calls are made." : syncState.error?.message || "Individual conversations can be enrolled from the active session."}</div></div><span class="status-dot ${syncState.connection === "available" ? "" : "off"}"></span></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">${syncServerEditable && syncAllEditable ? "Stored in config.json" : "One or more values are environment-controlled"}</span><button class="settings-save" data-act="save-sync-settings" ${syncServerEditable || syncAllEditable ? "" : "disabled"}>Save</button></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Repository sources</div>
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Default source</div><div class="sr-sub">Choose where the project picker opens first.</div></div>
            <select class="settings-select" data-setting="defaultRepositorySource" ${sourceEditable ? "" : "disabled"}>
              ${["local", "github", "git-url"].map(value => `<option value="${value}" ${source === value ? "selected" : ""}>${value === "local" ? "Local" : value === "github" ? "GitHub" : "Git URL"}</option>`).join("")}
            </select>
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">GitHub owner filter</div><div class="sr-sub">Only repositories owned by this account or organization are shown.</div></div>
            <input class="settings-inline-input" data-setting="githubOwner" value="${esc(owner)}" placeholder="bry-guy" ${ownerEditable ? "" : "disabled"}>
          </div>
          <div class="settings-row"><div class="sr-main"><div class="sr-title">GitHub account</div><div class="sr-sub">${esc(githubSummary)}. Use the project picker to sign in or choose a repository.</div><div class="provider-actions"><button class="settings-action" data-act="open-github-picker">${githubStatus?.authenticated ? "Manage repositories" : "Sign in with GitHub"}</button>${githubStatus?.authenticated && githubStatus.credentialSource === "stored" ? `<button class="settings-action quiet" data-github-logout>Sign out</button>` : ""}</div></div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">${sourceEditable && ownerEditable ? "Stored in config.json" : "One or more values are environment-controlled"}</span><div class="settings-actions"><button class="settings-save" data-act="save-repository-settings" ${sourceEditable || ownerEditable ? "" : "disabled"}>Save</button>${repositoryOperation}</div></div>
        </div>
      </section>
      <div class="settings-card">
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Default model</div><div class="sr-sub">Automatic uses the first available authenticated model.${store.state.defaultModelStatus === "unavailable" ? " The configured model is currently unavailable." : ""}</div></div>
          <pi-model-picker data-mode="default" data-variant="settings"></pi-model-picker>
        </div>
        <div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Default thinking mode</div><div class="sr-sub">Used for new chats; existing sessions keep their saved mode.</div></div>
          <select class="settings-select" data-setting="defaultThinkingLevel">
            ${thinkingLevels.map(level => `<option value="${level}" ${level === defaultThinkingLevel ? "selected" : ""}>${level}</option>`).join("")}
          </select>
        </div>
        <div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Local repositories</div><div class="sr-sub">Folder scanned by the project picker. Empty uses <span class="settings-mono">~/src</span>${store.state.reposRootSource === "environment" ? ". <span class=\"settings-mono\">PI_WEB_REPOS_ROOT</span> currently overrides this value" : ""}.</div></div>
          <div class="settings-path-control">
            <input class="repos-root-input" aria-label="Local repositories path" value="${esc(store.state.reposRoot || "")}" placeholder="~/src">
            <button class="settings-save" data-act="save-repos-root" ${store.state.reposRootSource === "environment" ? "disabled" : ""}>Save</button>
          </div>
        </div>
      </div>
    </div>`;
  }
}

/* ---------------- file panel ---------------- */
class PiFiles extends HTMLElement {
  connectedCallback() {
    this.requestId = 0;
    this.treeScroll = new Map();
    this.viewerScroll = new Map();
    this.unsub = store.subscribe(w => {
      if (["state", "files", "file"].includes(w)) this.render();
    });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='close']")) { this.close(); return; }
      const dir = e.target.closest("[data-dir]");
      if (dir) {
        store.state.openDirs[dir.dataset.dir] = !store.state.openDirs[dir.dataset.dir];
        this.render();
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
  disconnectedCallback() { this.unsub?.(); }

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
    store.set({ fileTarget: target, files: [], filesLoadedKey: null, filePath: null, fileView: null, fileLoading: false, fileError: null });
  }

  async openFile(filePath, target = store.state.fileTarget || "none") {
    const projectId = store.state.projectId;
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
      store.set({ filePath: null, fileView: null, fileLoading: false, fileError: null });
      return;
    }
    store.set({ filesOpen: false, filePath: null, fileView: null, fileLoading: false, fileError: null });
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
    this.innerHTML = `<aside class="files file-viewer">
      <div class="files-head file-viewer-head">
        <div class="file-title-wrap"><div class="sec-label">File</div><div class="file-path" title="${esc(s.filePath || "")}">${esc(s.filePath || "")}</div></div>
        <button class="ghost-btn" data-act="close" title="Back to files" aria-label="Back to files">×</button>
      </div>
      ${s.fileError ? `<div class="file-error">${esc(s.fileError)}</div>` : ""}
      <div class="file-view-scroll">
        <section class="file-section"><div class="file-section-head"><span>${title}</span>${meta}</div>${body}</section>
      </div>
    </aside>`;
  }

  render() {
    this.captureScroll();
    if (!(store.inProject() && store.state.filesOpen)) { this.innerHTML = ""; return; }
    if (store.state.filePath) {
      this.renderViewer();
      this.restoreScroll();
      return;
    }
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
      <div class="files-scroll">${out.join("")}</div>
    </aside>`;
    this.restoreScroll();
  }
}

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

  selectBranch(branch) {
    const picker = this.picker();
    if (!picker) return;
    picker.branch = branch;
    picker.branchMenuOpen = false;
    if (branch === "__new__" && !String(picker.newBranch || "").trim()) {
      picker.newBranch = featureBranchForName(picker.name);
      picker.newBranchAuto = !!picker.newBranch;
    }
    store.notify("state");
    if (branch === "__new__") queueMicrotask(() => this.querySelector("[data-session-new-branch]")?.focus());
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

  async refreshBranches() {
    if (this.busy) return;
    this.busy = true;
    this.busyLabel = "Refreshing branches…";
    const operation = beginOperation("refresh-contexts", "Refresh Git contexts", "", "Request started.", this.picker()?.sourceSessionId);
    store.set({ sessionPickerError: null });
    try {
      await refreshState();
      completeOperation(operation, { ok: true, httpStatus: 200, stdout: "Git contexts refreshed." });
    } catch (err) {
      completeOperation(operation, {}, err);
      store.set({ sessionPickerError: `Could not refresh branches: ${err.error || err.message || err}` });
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async syncConversation() {
    const id = this.picker()?.sourceSessionId;
    if (!id || this.busy || this.syncBusy) return;
    this.syncBusy = true;
    const operation = beginOperation("sync", "Synchronize this conversation", "", "Request started.");
    let result = null;
    try {
      result = await api.syncSession(id, operation.id);
      const source = store.findAnySession(id);
      if (source) {
        Object.assign(source, { synchronized: result.synchronized, syncState: result.syncState, syncError: result.syncError || null });
        store.notify("state");
      }
      completeOperation(operation, result);
      void refreshState().catch(err => store.setError(`Could not refresh sync state: ${err.message || err}`));
    } catch (err) {
      const displayError = Object.assign(new Error(syncErrorMessage(err)), err);
      completeOperation(operation, result || {}, displayError);
    } finally {
      this.syncBusy = false;
      this.render();
    }
  }

  async onClick(e) {
    const scrim = this.querySelector(".session-picker-scrim");
    if (e.target === scrim || e.target.closest("[data-act='close-session-picker']")) { this.close(); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "resume-session") {
      const project = this.project();
      const id = e.target.closest("[data-act]")?.dataset.id;
      if (project && id && !this.busy && !this.syncBusy) {
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
      this.selectBranch(e.target.closest("[data-act]").dataset.branch);
      return;
    }
    if (act === "refresh-session-contexts") {
      await this.refreshBranches();
      return;
    }
    if (act === "sync-session") {
      await this.syncConversation();
      return;
    }
    if (act === "create-session-context" || act === "apply-session-branch") { await this.submit(act === "apply-session-branch" ? e.target.closest("[data-act]").dataset.mode : "new"); return; }
    if (act === "run-hook") { await this.runHook(e.target.closest("[data-act]")?.dataset.hook); return; }
    if (act === "close-hook-result") { store.set({ hookResult: null }); return; }
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
      store.set({ sessionPicker: null, sessionPickerError: null });
      store.state.openTree[project.id] = true;
      selectSession(project.id, targetId);
      completeOperation(operation, result);
      const refresh = refreshState().catch(err => store.setError(`Could not refresh session state: ${err.message || err}`));
      if (mode === "switch") await refresh;
      else void refresh;
    } catch (err) {
      const messages = {
        no_such_base_branch: "That base branch no longer exists.",
        session_streaming: "Wait for the current response to finish before switching.",
        same_branch: "Choose a different branch.",
      };
      const displayError = Object.assign(new Error(messages[err.error] || gitErrorMessage(err)), err);
      completeOperation(operation, result || {}, displayError);
      store.set({ sessionPickerError: messages[err.error] || gitErrorMessage(err) });
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  async push() {
    const id = this.picker()?.sourceSessionId;
    const project = this.project();
    if (!id || !project || this.busy) return;
    this.busy = true;
    this.busyLabel = "Checking commits to push…";
    const operation = beginOperation("push-preview", "Review push", "", "Checking commits to push…");
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
    const id = this.picker()?.sourceSessionId;
    if (!id || !name || this.hookBusy) return;
    this.hookBusy = true;
    const title = name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Hook";
    const operation = beginOperation("hook", title, "", "Request started.");
    let result = null;
    try {
      result = await api.hook(id, name, operation.id);
      completeOperation(operation, result);
      void refreshState().catch(err => store.setError(`Could not refresh hook state: ${err.message || err}`));
    } catch (err) {
      completeOperation(operation, result || {}, err);
    } finally { this.hookBusy = false; this.render(); }
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
    const baseOptions = branches.map(branch => `<option value="${esc(branch)}" ${(picker.baseBranch || primary) === branch ? "selected" : ""}>${esc(branch)}</option>`).join("");
    const existing = mode !== "new";
    const sourceSession = existing && picker.sourceSessionId ? store.findAnySession(picker.sourceSessionId) : null;
    const sourceStreaming = !!sourceSession && (sourceSession.streaming || store.transcript(sourceSession.id).streaming);
    const syncReady = existing && picker.sourceSessionId && sourceSession
      && store.state.sync?.configured && store.state.sync.connection === "available"
      && !sourceStreaming && (!sourceSession.synchronized || sourceSession.syncState === "error");
    const syncButton = syncReady
      ? `<button class="settings-action" data-act="sync-session" title="Synchronize this conversation" aria-label="Synchronize this conversation" ${this.busy || this.syncBusy ? "disabled" : ""}>${this.syncBusy ? "syncing…" : "sync"}</button>`
      : "";
    const current = picker.currentBranch || "";
    const primarySelected = current === primary;
    const actionButtons = existing
      ? `<button class="settings-action" data-act="apply-session-branch" data-mode="switch" ${this.busy || !different ? "disabled" : ""}>Switch</button><button class="settings-save" data-act="apply-session-branch" data-mode="fork" ${this.busy || !different ? "disabled" : ""}>Fork</button>`
      : `<button class="settings-save" data-act="create-session-context" ${this.busy || !effectiveBranch ? "disabled" : ""}>${this.busy ? esc(this.busyLabel || "Creating…") : "Create session"}</button>`;
    const primaryReason = `Unavailable for ${primary}; ${primary} is the primary checkout.`;
    const branchActions = existing && current && effectiveBranch === current ? `<section class="session-branch-actions"><div class="session-context-heading"><span>Git</span></div><div class="workspace-actions"><button class="settings-action" data-act="merge-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : `Merge to ${esc(primary)}`}">Merge to ${esc(primary)}</button><button class="settings-action" data-act="push-branch" ${this.busy ? "disabled" : ""}>${this.busy && this.busyLabel === "Checking commits to push…" ? esc(this.busyLabel) : "Push"}</button><button class="settings-action danger-outline" data-act="delete-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : "Delete local branch"}">Delete</button></div></section>` : "";
    const hookNames = existing && picker.sourceSessionId ? Object.entries(project.hooks || {}).filter(([name, enabled]) => enabled && name).map(([name]) => name) : [];
    const hookLabel = name => name ? `${name[0].toUpperCase()}${name.slice(1)}` : name;
    const hookButtons = hookNames.map(name => `<button class="settings-action" data-act="run-hook" data-hook="${esc(name)}" ${this.hookBusy ? "disabled" : ""}>${esc(hookLabel(name))}</button>`).join("");
    const hookSection = hookButtons ? `<div class="workspace-actions">${hookButtons}</div>` : "";
    const historySessions = mode === "new" ? this.flatten(project.sessions) : [];
    const historyRows = historySessions.map(session => {
      const sessionBranch = session.branch || contexts.find(item => item.id === session.contextId)?.branch || primary;
      return `<button type="button" class="session-history-row" data-act="resume-session" data-id="${esc(session.id)}" aria-label="Resume ${esc(session.title || "Untitled session")}"><span class="session-history-main"><strong>${esc(session.title || "Untitled session")}</strong><small>${esc(sessionBranch)}${session.when ? ` · ${esc(session.when)}` : ""}</small></span><span class="session-history-resume">Resume</span></button>`;
    }).join("");
    const historySection = mode === "new" ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>History</span><span>${historySessions.length} session${historySessions.length === 1 ? "" : "s"}</span></div><div class="session-history-scroll">${historyRows || `<div class="session-history-empty">No previous sessions yet.</div>`}</div></section>` : "";
    const error = store.state.sessionPickerError ? `<div class="session-picker-error">${esc(store.state.sessionPickerError)}</div>` : "";
    const progress = this.busy ? `<div class="session-picker-progress" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${esc(this.busyLabel || "Working…")}</span></div>` : "";
    const operationProgress = [
      operationFeedback("sync", "Synchronizing conversation…"),
      operationFeedback("refresh-contexts", "Refreshing Git contexts…"),
      operationFeedback("push-preview", "Checking commits to push…"),
      operationFeedback(["create-session", "switch-session", "fork-session"], "Updating session workspace…"),
      operationFeedback(["push", "hook", "merge", "delete"], "Running Git operation…"),
    ].filter(Boolean).join("");
    const subtitle = existing ? `${esc(project.name)} · switch or fork this conversation` : `${esc(project.name)} · choose a branch for this conversation`;
    this.innerHTML = `<div class="session-picker-scrim"><section class="session-picker" role="dialog" aria-label="${existing ? "Session" : "New session"}"><div class="session-picker-head"><div><div class="modal-title">${existing ? "Session" : "New session"}</div><div class="session-picker-subtitle">${subtitle}</div></div><button class="ghost-btn" data-act="close-session-picker" aria-label="Close">×</button></div><div class="session-picker-body" aria-busy="${!!this.busy}"><label class="session-picker-source"><span>Name</span><input class="session-name-input" data-session-name value="${esc(picker.name || "")}" placeholder="Autonamed if empty" autocomplete="off"></label><label class="session-picker-source"><span>Branch</span>${branchField}</label>${isNew ? `<label class="session-picker-source"><span>New branch name</span><input class="session-branch-input" data-session-new-branch value="${esc(picker.newBranch || "")}" placeholder="feature/my-change" autocomplete="off"></label><label class="session-picker-source"><span>Based on</span><select data-session-base-branch>${baseOptions}</select></label><div class="session-picker-help">Non-${esc(primary)} branches use worktrees.</div>` : ""}${historySection}<div class="session-context-heading"><span>Workspace</span><div class="session-context-heading-actions">${syncButton}<button class="settings-action quiet" data-act="refresh-session-contexts" ${this.busy || this.syncBusy ? "disabled" : ""}>${this.busy && this.busyLabel === "Refreshing branches…" ? "Refreshing…" : "Refresh"}</button></div></div>${progress}${operationProgress}<div class="session-context-users branch-user-list">${userText}</div>${error}${hookSection}${branchActions}</div><div class="session-picker-actions"><div class="session-context-heading session-picker-actions-heading"><span>Session</span></div><div class="session-picker-action-buttons"><button class="settings-action quiet" data-act="close-session-picker" ${this.busy ? "disabled" : ""}>Cancel</button>${actionButtons}</div></div></section></div>`;
    if (focusSelector) {
      const next = this.querySelector(focusSelector);
      if (next) {
        next.focus({ preventScroll: true });
        if (selectionStart != null && typeof next.setSelectionRange === "function") next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
      }
    }
  }
}
/* ---------------- repo picker ---------------- */
class PiRepoPicker extends HTMLElement {
  connectedCallback() {
    this.repoRoot = store.state.reposRoot;
    this.source = null;
    this.sourceMenuOpen = false;
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.repoPickerOpen) {
        e.preventDefault();
        void this.dismiss();
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
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
      if (e.target.matches(".modal-filter")) {
        store.state.repoQuery = e.target.value;
        this.loaded = false;
        this.renderResults();
        void this.load();
      }
      if (e.target.matches(".git-url-input")) this.gitUrl = e.target.value;
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    clearTimeout(this.githubTimer);
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }
  async dismiss() {
    await this.cancelGithubLogin();
    store.set({ repoPickerOpen: false, repoPickerSource: null });
  }
  availableSources() {
    const configured = store.state.repositorySources?.sources || [];
    const enabled = new Set(configured.filter(source => source.enabled !== false).map(source => source.id));
    return ["local", "github", "git-url"].filter(id => !configured.length || enabled.has(id));
  }
  chooseSource(source) {
    if (!this.availableSources().includes(source)) return;
    const changed = this.source !== source;
    this.source = source;
    if (changed) store.state.repoQuery = "";
    store.state.repoPickerSource = source;
    this.sourceMenuOpen = false;
    this.loaded = false;
    this.errorMsg = null;
    this.githubRepos = [];
    this.render();
    void this.load();
  }
  async onClick(e) {
    const scrim = this.querySelector(".scrim");
    if (e.target === scrim || e.target.closest("[data-act='close']")) {
      void this.dismiss(); return;
    }
    const sourceToggle = e.target.closest("[data-source-toggle]");
    if (sourceToggle) { this.sourceMenuOpen = !this.sourceMenuOpen; this.render(); return; }
    const source = e.target.closest("[data-source]");
    if (source) { this.chooseSource(source.dataset.source); return; }
    if (e.target.closest("[data-github-login]")) { void this.startGithubLogin(); return; }
    if (e.target.closest("[data-github-more]")) { void this.loadGithubMore(); return; }
    if (e.target.closest("[data-github-cancel]")) { void this.cancelGithubLogin(); return; }
    if (e.target.closest("[data-git-url-connect]")) { void this.connect("git-url", this.querySelector(".git-url-input")?.value); return; }
    const row = e.target.closest("[data-repo]");
    if (!row) return;
    const value = row.dataset.repo;
    await this.connect(this.source || "local", value, row.dataset.fullName);
  }
  async connect(source, value, fullName) {
    if (this.connecting) return;
    this.connecting = true;
    this.errorMsg = null;
    this.renderResults();
    try {
      const body = source === "local" ? { source, repoPath: value } : source === "github" ? { source, fullName } : { source, url: value };
      const result = await api.newProject(body);
      this.connecting = false;
      store.set({ repoPickerOpen: false, repoPickerSource: null });
      await refreshState();
      store.state.openTree[result.id] = true;
      selectSession(result.id, result.sessionId, { showOperation: true });
      store.set({ hookResult: null, workspaceSettingsOpen: result.setup && !result.setup.ok });
      if (result.setup) showCompletedOperation("hook", "Setup", result.setup);
    } catch (err) {
      this.connecting = false;
      const messages = {
        project_exists: "Already connected.",
        not_a_git_repo: "Not a git repository.",
        github_auth_required: "Connect GitHub before selecting a private repository.",
        repository_exists: "That repository already exists in the repository root.",
        branch_exists: "That branch already exists.",
        clone_failed: "Git could not clone this repository.",
        invalid_git_url: "Use a public HTTPS Git URL.",
      };
      this.errorMsg = messages[err.error] || String(err.message || err.error || err);
      this.renderResults();
    }
  }
  async load() {
    if (this.loaded || !store.state.repoPickerOpen) return;
    this.loaded = true;
    const source = this.source || "local";
    if (source === "git-url") { this.renderResults(); return; }
    if (source === "github") {
      const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
      this.githubNextPage = null;
      if (!status?.authenticated && !status?.owner) {
        this.githubRepos = [];
        this.errorMsg = "Set a GitHub owner in Settings to browse public repositories, or sign in to list your repositories.";
        this.renderResults();
        return;
      }
      try {
        const result = status?.authenticated
          ? await api.githubRepos(store.state.repoQuery)
          : await api.githubPublicRepos(status?.owner, store.state.repoQuery);
        this.githubRepos = result.repos || [];
        this.githubNextPage = result.nextPage;
        this.githubPublicOnly = !status?.authenticated;
      } catch (err) {
        this.errorMsg = err.error === "github_auth_required"
          ? "Sign in with GitHub to list private repositories."
          : err.error === "github_owner_required"
            ? "Set a default GitHub owner in Settings to browse public repositories."
            : `Could not load GitHub repositories: ${err.message || err.error || err}`;
        this.githubRepos = [];
      }
      this.renderResults();
      return;
    }
    try {
      const { repos, root } = await api.repos();
      store.set({ repos, reposRoot: root });
    } catch (err) {
      this.errorMsg = `Could not load repositories: ${err.error || err.message || err}`;
      store.set({ repos: [] });
    }
    this.renderResults();
  }
  async loadGithubMore() {
    if (!this.githubNextPage || this.githubMoreLoading) return;
    const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
    const page = this.githubNextPage;
    this.githubMoreLoading = true;
    this.renderResults();
    try {
      const result = status?.authenticated
        ? await api.githubRepos(store.state.repoQuery, page)
        : await api.githubPublicRepos(status?.owner, store.state.repoQuery, page);
      const existing = new Set((this.githubRepos || []).map(repo => repo.fullName));
      this.githubRepos = [...(this.githubRepos || []), ...(result.repos || []).filter(repo => !existing.has(repo.fullName))];
      this.githubNextPage = result.nextPage;
      this.errorMsg = null;
    } catch (err) {
      this.errorMsg = `Could not load more GitHub repositories: ${err.message || err.error || err}`;
    } finally {
      this.githubMoreLoading = false;
      this.renderResults();
    }
  }
  async startGithubLogin() {
    if (this.githubFlow) return;
    try {
      const result = await api.githubLogin();
      this.githubFlow = result.flow;
      this.renderResults();
      void this.pollGithubLogin(this.githubFlow.id);
    } catch (err) {
      this.errorMsg = err.error === "github_not_configured" ? "GitHub OAuth is not configured on the server." : `GitHub login failed: ${err.message || err.error || err}`;
      this.renderResults();
    }
  }
  async pollGithubLogin(id) {
    clearTimeout(this.githubTimer);
    if (!store.state.repoPickerOpen || this.githubFlow?.id !== id) return;
    try {
      const result = await api.githubFlow(id);
      if (!store.state.repoPickerOpen || this.githubFlow?.id !== id) return;
      this.githubFlow = result.flow;
      if (["complete", "error", "cancelled"].includes(this.githubFlow.state)) {
        if (this.githubFlow.state === "complete") {
          const accountLogin = this.githubFlow.account?.login;
          const ownerUnset = !store.state.settings?.githubOwner?.value;
          this.githubFlow = null;
          if (accountLogin && ownerUnset) {
            const operation = beginOperation("pi-profile", "Load GitHub dotfiles", "", "Request started.");
            try {
              const profileResult = await api.settingsPatch({ githubOwner: accountLogin, operationId: operation.id, activeSessionId: store.activeKey() });
              completeOperation(operation, profileResult);
            } catch (error) {
              completeOperation(operation, {}, error);
            }
          }
          await refreshState();
          this.loaded = false;
          this.errorMsg = null;
          await this.load();
        } else {
          this.errorMsg = this.githubFlow.error?.message || "GitHub login did not complete.";
          this.githubFlow = null;
          this.renderResults();
        }
        return;
      }
      this.renderResults();
      this.githubTimer = setTimeout(() => this.pollGithubLogin(id), 1000);
    } catch (err) {
      this.githubFlow = null;
      this.errorMsg = `GitHub login status failed: ${err.message || err.error || err}`;
      this.renderResults();
    }
  }
  async cancelGithubLogin() {
    const id = this.githubFlow?.id;
    clearTimeout(this.githubTimer);
    this.githubFlow = null;
    if (id) await api.githubCancel(id).catch(() => {});
    if (store.state.repoPickerOpen) this.renderResults();
  }
  render() {
    if (!store.state.repoPickerOpen) {
      this.innerHTML = ""; this.loaded = false; this.errorMsg = null; this.sourceMenuOpen = false; this.source = null; return;
    }
    if (!this.source) this.source = store.state.repoPickerSource || store.state.repositorySources?.default || "local";
    if (!this.querySelector(".scrim")) {
      this.innerHTML = `<div class="scrim">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title-row">
              <div class="modal-title">Select a repository</div>
              <button class="ghost-btn" data-act="close" style="font-size:15px">×</button>
            </div>
            <div class="modal-filter-row">
              <div class="source-picker">
                <button class="account-chip" data-source-toggle aria-haspopup="listbox" aria-expanded="false">Local ▾</button>
                <div class="source-menu" hidden></div>
              </div>
              <input class="modal-filter" placeholder="Find a repository" aria-label="Find a repository">
            </div>
          </div>
          <div class="modal-list"></div>
        </div>
      </div>`;
    }
    const label = { local: "Local", github: "GitHub", "git-url": "Git URL" }[this.source] || "Local";
    const toggle = this.querySelector("[data-source-toggle]");
    if (toggle) { toggle.textContent = `${label} ▾`; toggle.setAttribute("aria-expanded", String(this.sourceMenuOpen)); }
    const menu = this.querySelector(".source-menu");
    if (menu) {
      menu.hidden = !this.sourceMenuOpen;
      menu.innerHTML = this.availableSources().map(source => `<button data-source="${source}" role="option" aria-selected="${source === this.source}">${source === "local" ? "Local" : source === "github" ? "GitHub" : "Git URL"}</button>`).join("");
    }
    const filter = this.querySelector(".modal-filter");
    if (filter) {
      filter.hidden = this.source === "git-url";
      filter.placeholder = this.source === "github" ? "Find a GitHub repository" : "Find a repository";
      if (filter.value !== store.state.repoQuery && document.activeElement !== filter) filter.value = store.state.repoQuery;
    }
    this.renderResults();
    void this.load();
  }
  renderResults() {
    const list = this.querySelector(".modal-list");
    if (!list) return;
    const source = this.source || "local";
    if (this.connecting) {
      list.innerHTML = `<div class="modal-empty">Connecting repository…</div>`;
      return;
    }
    if (this.githubFlow) {
      const flow = this.githubFlow;
      list.innerHTML = `<div class="github-login-state"><div>Open <a href="${esc(flow.verificationUri)}" target="_blank" rel="noopener">${esc(flow.verificationUri)}</a></div><strong>${esc(flow.userCode || "")}</strong><div>Approve access, then leave this dialog open.</div><button class="settings-action" data-github-cancel>Cancel</button></div>`;
      return;
    }
    if (source === "git-url") {
      list.innerHTML = `<div class="git-url-form"><label for="git-url-input">Public HTTPS Git URL</label><input id="git-url-input" class="git-url-input" value="${esc(this.gitUrl || "")}" placeholder="https://github.com/owner/repository.git"><button class="connect-btn" data-git-url-connect>Connect</button><div class="modal-help">Private GitHub repositories use the GitHub source. SSH URLs are not supported yet.</div>${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}</div>`;
      return;
    }
    if (source === "github") {
      const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
      const q = store.state.repoQuery.trim().toLowerCase();
      const rows = (this.githubRepos || [])
        .filter(repo => !q || repo.name.toLowerCase().includes(q) || repo.fullName.toLowerCase().includes(q))
        .map(repo => `<div class="repo-row" role="button" tabindex="0" data-repo="${esc(repo.fullName)}" data-full-name="${esc(repo.fullName)}"><div class="rr-main"><div class="rr-name">${esc(repo.name)}</div><div class="rr-meta"><span>${esc(repo.fullName)}</span></div></div><span class="rr-vis">${repo.private ? "private" : "public"}</span></div>`).join("");
      const login = !status?.authenticated
        ? `<div class="github-login-banner"><span>${status?.configured ? "Sign in to include private repositories." : "Sign in to access GitHub repositories."}</span><button class="settings-action" data-github-login>Sign in with GitHub</button></div>`
        : "";
      const setup = !status?.configured && !status?.owner
        ? `<div class="modal-empty">GitHub sign-in needs server app setup. Set the advanced <span class="settings-mono">PI_WEB_GITHUB_CLIENT_ID</span> override.</div>`
        : "";
      const empty = !rows && !this.errorMsg && !setup && !this.githubNextPage
        ? `<div class="modal-empty">No public GitHub repositories ${q ? "match" : `were found for ${esc(status?.owner || "this owner")}`}.</div>` : "";
      const more = this.githubNextPage
        ? `<button class="settings-action github-more" data-github-more ${this.githubMoreLoading ? "disabled" : ""}>${this.githubMoreLoading ? "Loading…" : "Load more repositories"}</button>`
        : "";
      list.innerHTML = `${login}${setup}${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}${rows || empty}${more}`;
      return;
    }
    const raw = store.state.repoQuery.trim();
    const q = raw.toLowerCase();
    const results = store.state.repos.filter(r => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    const isPath = raw.startsWith("/") || raw.startsWith("~/") || raw === "~";
    const pathRow = isPath ? `<div class="repo-row" role="button" tabindex="0" data-repo="${esc(raw)}"><div class="rr-main"><div class="rr-name">Connect ${esc(raw)}</div><div class="rr-meta"><span>use this path directly</span></div></div><span class="rr-vis">path</span></div>` : "";
    const rows = results.map(r => `<div class="repo-row" role="button" tabindex="0" data-repo="${esc(r.path)}"><div class="rr-main"><div class="rr-name">${esc(r.name)}</div><div class="rr-meta"><span>${esc(r.path)}</span></div></div><span class="rr-vis">local</span></div>`).join("");
    const empty = `<div class="modal-empty">No repositories ${q ? "match" : `found under ${esc(store.state.reposRoot || "the repos root")}`}.<br>Type an absolute path to a git repo to connect it, or set PI_WEB_REPOS_ROOT.</div>`;
    list.innerHTML = `${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}${pathRow}${rows || (pathRow ? "" : empty)}`;
  }
}

/* ---------------- logs modal ---------------- */
class PiLogs extends HTMLElement {
  connectedCallback() {
    this.loaded = false;
    this.loading = false;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.logsOpen) {
        e.preventDefault();
        store.set({ logsOpen: false });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => this.onClick(e));
    this.render();
  }

  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }

  async onClick(e) {
    const scrim = this.querySelector(".logs-scrim");
    if (e.target === scrim || e.target.closest("[data-act='close-logs']")) {
      store.set({ logsOpen: false });
      return;
    }
    if (e.target.closest("[data-act='refresh-logs']")) await this.load();
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    store.set({ logsLoading: true, logsError: null });
    try {
      const result = await api.logs(800);
      store.set({ logs: Array.isArray(result.logs) ? result.logs : [], logsFile: result.file || "logs/pi-ez-web.log", logsLoading: false, logsError: null });
    } catch (error) {
      store.set({ logsLoading: false, logsError: error.error || error.message || String(error) });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  time(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour12: false });
  }

  localOperation(operation) {
    const status = operation.status === "error" ? "error" : operation.status === "success" ? "success" : "running";
    const events = (operation.events || []).map(item => {
      const message = item.message || item.output || item.type || "Progress update.";
      return `<div class="logs-event ${item.type === "error" || item.stream === "stderr" ? "error" : item.type === "result" ? "success" : "info"}"><time>${this.time(item.at)}</time><span>${esc(message)}</span></div>`;
    }).join("");
    return `<section class="logs-operation ${status}"><div class="logs-operation-head"><strong>${esc(operation.title)}</strong><span>${status}</span></div>${events || `<div class="logs-event info"><span>${esc(operationHint(operation))}</span></div>`}</section>`;
  }

  serverEntry(entry) {
    const status = entry.level === "error" || entry.type === "error" ? "error" : entry.type === "result" ? "success" : "info";
    const source = [entry.source, entry.kind, entry.phase].filter(Boolean).join(" · ");
    const detail = entry.output && entry.output !== entry.message ? `<div class="logs-detail">${esc(entry.output)}</div>` : "";
    return `<div class="logs-event ${status}"><time>${this.time(entry.at)}</time>${source ? `<small>${esc(source)}</small>` : ""}<span>${esc(entry.message || entry.type || "Log entry")}</span>${detail}</div>`;
  }

  render() {
    if (!store.state.logsOpen) {
      this.loaded = false;
      this.innerHTML = "";
      return;
    }
    if (!this.loaded) {
      this.loaded = true;
      queueMicrotask(() => void this.load());
    }
    const operations = (store.state.operations || []).map(operation => this.localOperation(operation)).join("");
    const serverLogs = (store.state.logs || []).map(entry => this.serverEntry(entry)).join("");
    const loading = store.state.logsLoading ? `<div class="logs-empty">Loading server logs…</div>` : "";
    const error = store.state.logsError ? `<div class="logs-error">Could not load the server log: ${esc(store.state.logsError)}</div>` : "";
    this.innerHTML = `<div class="logs-scrim"><section class="logs-modal" role="dialog" aria-modal="true" aria-label="Logs"><div class="logs-head"><div><div class="logs-title">Logs</div><div class="logs-subtitle">Live actions in this tab and the server log file.</div></div><button class="ghost-btn" data-act="close-logs" aria-label="Close">×</button></div><div class="logs-body">${error}${loading}<section class="logs-section"><div class="logs-section-title">Recent actions</div>${operations || `<div class="logs-empty">No actions have run in this tab.</div>`}</section><section class="logs-section"><div class="logs-section-title">Server log · ${esc(store.state.logsFile || "logs/pi-ez-web.log")}</div><div class="logs-server-list">${serverLogs || `<div class="logs-empty">No server log entries yet.</div>`}</div></section></div><div class="logs-actions"><button class="settings-action quiet" data-act="refresh-logs" ${store.state.logsLoading ? "disabled" : ""}>Refresh</button><button class="settings-save" data-act="close-logs">Close</button></div></section></div>`;
  }
}

/* ---------------- confirmation modal ---------------- */
class PiConfirm extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => {
      const scrim = this.querySelector(".confirm-scrim");
      if (e.target === scrim || e.target.closest("[data-act='cancel']")) store.set({ confirm: null });
      else if (e.target.closest("[data-act='go']")) void this.go();
    });
    this.addEventListener("change", e => {
      if (e.target.matches("[data-confirm-delete-after]")) store.set(s => ({ confirm: { ...s.confirm, deleteAfter: e.target.checked } }));
      if (e.target.matches("[data-confirm-close-sessions]")) store.set(s => ({ confirm: { ...s.confirm, closeSessions: e.target.checked } }));
      if (e.target.matches("[data-confirm-force]")) store.set(s => ({ confirm: { ...s.confirm, force: e.target.checked } }));
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async go() {
    const c = store.state.confirm;
    if (!c || this.busy) return;
    const project = store.state.projects.find(item => item.id === c.projectId);
    const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
    this.busy = true;
    this.busyLabel = c.type === "merge" ? `Fetching ${primary}…` : c.type === "push" ? "Pushing commits…" : c.type === "deleteBranch" ? "Deleting branch…" : "Working…";
    const operation = ["merge", "push", "deleteBranch"].includes(c.type)
      ? beginOperation(c.type === "merge" ? "merge" : c.type === "push" ? "push" : "delete", c.type === "merge" ? `Merge ${c.branch}` : c.type === "push" ? `Push ${c.branch}` : `Delete ${c.branch}`, "", "Request started.")
      : null;
    let result = null;
    let followup = null;
    try {
      if (c.type === "close") {
        await api.close(c.id);
      } else if (c.type === "merge") {
        result = await api.mergeBranch(c.id, operation?.id);
      } else if (c.type === "push") {
        result = await api.pushBranch(c.id, operation?.id, { head: c.head, baseHead: c.baseHead });
      } else if (c.type === "deleteBranch") {
        result = await api.deleteBranch(c.projectId, c.branch, { force: !!c.force, closeSessions: !!c.closeSessions, operationId: operation?.id });
      }
      await refreshState();
      if (operation) completeOperation(operation, combineOperationResults(result, followup));
      store.set({ confirm: null });
      const active = store.state.sessionId;
      if (c.type === "merge" && active && store.findAnySession(active)) openSessionPicker(c.projectId, { mode: "switch", sourceSessionId: active });
      if (active && !store.findAnySession(active)) {
        const project = store.state.projects.find(item => item.id === c.projectId);
        const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
        const first = this.flatten(project?.sessions || []).find(session => session.branch === primary) || this.flatten(project?.sessions || [])[0];
        if (first) selectSession(c.projectId, first.id);
      }
    } catch (err) {
      if (operation) {
        const prior = combineOperationResults(result, followup);
        completeOperation(operation, { ...prior, stderr: [prior.stderr, err.detail || err.message || String(err)].filter(Boolean).join("\n") }, err);
      }
      const activeConfirm = store.state.confirm;
      if (activeConfirm?.id === c.id && activeConfirm.type === c.type) store.set({ confirm: { ...activeConfirm, error: gitErrorMessage(err) } });
      else store.setError(`Could not complete ${c.type || "operation"}: ${gitErrorMessage(err)}`);
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  flatten(nodes) { return (nodes || []).flatMap(node => [node, ...this.flatten(node.children)]); }

  render() {
    const c = store.state.confirm;
    if (!c) { this.innerHTML = ""; return; }
    const project = store.state.projects.find(item => item.id === c.projectId);
    const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
    const sessions = c.sessions || [];
    const activeSessions = sessions.filter(session => session.streaming);
    const sessionList = sessions.length ? `<div class="confirm-sessions"><strong>Sessions using this branch</strong>${sessions.map(session => `<div>${esc(session.title)} · ${session.streaming ? "working" : "idle"}</div>`).join("")}</div>` : "";
    let title = "", body = "", options = "", action = "Confirm";
    if (c.type === "close") {
      title = c.kind === "chat" ? "Close chat" : "Close session";
      body = `“${esc(c.label)}” will be archived. Its transcript and Git context remain available.`;
      action = c.kind === "chat" ? "Close chat" : "Close session";
    } else if (c.type === "merge") {
      title = `Merge ${esc(c.branch)} to ${esc(primary)}?`;
      body = `This merges into the local ${esc(primary)} checkout, returns affected sessions to it, and deletes the local branch and worktree. It does not push.`;
      options = sessions.length ? `<div class="confirm-warn">${sessions.length} session${sessions.length === 1 ? "" : "s"} will return to ${esc(primary)} after the merge.</div>` : "";
      action = "Merge locally";
    } else if (c.type === "push") {
      title = `Push ${esc(c.branch)}?`;
      body = `Push ${c.commitCount} commit${c.commitCount === 1 ? "" : "s"} from ${esc(c.branch)} to ${esc(c.upstream)}.`;
      options = c.commits?.length
        ? `<div class="confirm-commits"><strong>Commits to push</strong>${c.commits.map(commit => `<div><code>${esc(commit.shortHash || commit.hash?.slice(0, 7) || "commit")}</code><span>${esc(commit.subject || "(no subject)")}</span></div>`).join("")}${c.commitCount > c.commits.length ? `<small>Showing ${c.commits.length} of ${c.commitCount} commits.</small>` : ""}</div>`
        : `<div class="confirm-warn">No new commits are ahead of ${esc(c.upstream)}.</div>`;
      action = "Push commits";
    } else {
      title = `Delete ${esc(c.branch)}?`;
      body = `The local branch and worktree will be deleted. Remote branches are not affected.${activeSessions.length ? " Working sessions will be interrupted." : ""}`;
      options = `${sessions.length ? `<div class="confirm-warn">Affected sessions will move to ${esc(primary)} unless you choose to close them.</div>` : ""}${activeSessions.length ? `<label class="confirm-check"><input type="checkbox" data-confirm-close-sessions ${c.closeSessions ? "checked" : ""}><span>Close affected sessions instead of moving them to ${esc(primary)}</span></label>` : ""}${c.dirty ? `<label class="confirm-check"><input type="checkbox" data-confirm-force ${c.force ? "checked" : ""}><span>I understand uncommitted changes will be deleted</span></label>` : ""}`;
      action = "Delete branch";
    }
    const disabled = this.busy || (c.type === "deleteBranch" && c.dirty && !c.force) || (c.type === "push" && !c.commitCount);
    const progressOperation = c.type === "deleteBranch" ? operationFor("delete") : ["merge", "push"].includes(c.type) ? operationFor(c.type) : null;
    const progress = this.busy
      ? `<div class="confirm-progress" role="status" aria-live="polite"><i class="operation-dot" aria-hidden="true"></i><span>${esc(operationHint(progressOperation, this.busyLabel || "Working…"))}</span></div>`
      : "";
    this.innerHTML = `<div class="confirm-scrim"><div class="confirm-modal" role="dialog" aria-modal="true" aria-busy="${this.busy}"><div class="confirm-title">${title}</div><div class="confirm-body">${body}${sessionList}${options}</div>${c.error ? `<div class="confirm-error">${esc(c.error)}</div>` : ""}<div class="confirm-actions"><button class="confirm-back" data-act="cancel">Go back</button><div class="confirm-action-main"><button class="confirm-cta danger" data-act="go" ${disabled ? "disabled" : ""}>${this.busy ? "Working…" : action}</button>${progress}</div></div></div></div>`;
  }
}

/* ---------------- app root ---------------- */
class PiApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="frame">
        <div class="preview-banner hidden" data-preview-banner role="status" aria-label="Preview environment"></div>
        <div class="shell">
        <pi-sidebar></pi-sidebar>
        <main class="col">
          <pi-header></pi-header>
          <div class="screen" data-screen="chat">
            <div class="scrollable"><div class="col-pad"><pi-thread></pi-thread></div></div>
            <pi-composer></pi-composer>
          </div>
          <div class="screen" data-screen="settings"><div class="scrollable"><pi-settings></pi-settings></div></div>
        </main>
        <pi-files></pi-files>
        <div class="drawer-scrim hidden"></div>
        <div class="connection-status hidden" data-connection-status></div>
        <div class="update-prompt hidden" data-update-prompt>
          <span>New pi update ready.</span><button class="update-btn" data-act="update">Reload</button>
        </div>
        <pi-repo-picker></pi-repo-picker>
        <pi-session-picker></pi-session-picker>
        <pi-logs></pi-logs>
        <pi-confirm></pi-confirm>
        <div class="reload-prompt hidden" data-reload-prompt>
          <div class="reload-card"><div class="screen-title">Reload required</div><div class="proj-sub" data-reload-message></div><button class="primary-btn" data-act="reload">Reload</button></div>
        </div>
      </div></div>`;
    this.scrim = this.querySelector(".drawer-scrim");
    this.scrim.addEventListener("click", () => store.set({ drawerOpen: false }));
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='reload']")) location.reload();
      if (e.target.closest("[data-act='update']")) {
        e.preventDefault();
        store.set({ updateAvailable: false });
        if (typeof window.__piApplyUpdate === "function") window.__piApplyUpdate();
        else location.reload();
      }
    });
    this.addEventListener("toggle-files", () => {
      const open = !store.state.filesOpen;
      store.set({ filesOpen: open, fileError: null, filePath: null, fileView: null, fileLoading: false });
      if (!open) return;
      this.ensureFiles(true);
    });
    this.unsub = store.subscribe(w => { if (w === "state") this.sync(); });
    this.onResize = () => this.sync();
    window.addEventListener("resize", this.onResize);
    this.gitRefreshTimer = setInterval(() => {
      // Do not replace the picker DOM while a user is typing or choosing a
      // branch. The explicit Refresh action owns modal Git updates.
      if (store.inProject() && !store.state.sessionPicker && !store.state.confirm) void refreshState().catch(() => {});
    }, 3500);
    this.gitRefreshTimer.unref?.();
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    clearInterval(this.gitRefreshTimer);
    window.removeEventListener("resize", this.onResize);
    document.body?.classList.remove("modal-open");
  }

  filesKey() {
    const p = store.project();
    if (!p || !store.inProject()) return null;
    const node = store.findSession(store.state.sessionId);
    return `${p.id}:${node?.contextId || node?.workspacePath || p.contexts?.[0]?.id || ""}:${store.state.fileTarget}`;
  }

  async ensureFiles(force = false) {
    if (!(store.inProject() && store.state.filesOpen)) return;
    const key = this.filesKey();
    if (!key) return;
    if (this.activeFilesKey && this.activeFilesKey !== key) {
      store.state.filePath = null;
      store.state.fileView = null;
      store.state.fileLoading = false;
      store.notify("file");
    }
    this.activeFilesKey = key;
    if (!force && (key === store.state.filesLoadedKey || key === this.loadingFilesKey)) return;
    this.loadingFilesKey = key;
    store.state.files = [];
    store.state.filesLoadedKey = null;
    store.state.fileError = null;
    store.notify("files");
    const node = store.findSession(store.state.sessionId);
    try {
      const result = await api.files(store.state.projectId, node?.contextId || store.project()?.contexts?.[0]?.id, store.state.fileTarget);
      if (this.filesKey() === key) {
        store.state.files = result.tree || [];
        store.state.fileTargets = result.targets || store.state.fileTargets;
        store.state.fileTarget = result.target || store.state.fileTarget;
        store.state.filesLoadedKey = key;
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
    const modalOpen = !!(store.state.repoPickerOpen || store.state.sessionPicker || store.state.logsOpen || store.state.confirm || store.state.workspaceSettingsOpen);
    document.body?.classList.toggle("modal-open", modalOpen);
    const previewBanner = this.querySelector("[data-preview-banner]");
    const preview = store.state.uiConfig?.preview === true;
    if (previewBanner) {
      previewBanner.textContent = store.state.uiConfig?.label || "Preview UI · production data";
      previewBanner.classList.toggle("hidden", !preview);
    }
    const bar = this.querySelector("pi-header .bar");
    if (bar) this.style.setProperty("--header-height", `${bar.getBoundingClientRect().height}px`);
    for (const el of this.querySelectorAll("[data-screen]")) el.classList.toggle("hidden", el.dataset.screen !== v);
    this.scrim.classList.toggle("hidden", !(mobile() && store.state.drawerOpen));
    const connection = this.querySelector("[data-connection-status]");
    const offline = store.state.offline;
    connection.textContent = offline ? "Offline — reconnecting when network returns…" : "Reconnecting to pi-ez-web…";
    connection.classList.toggle("hidden", (!offline && !store.state.reconnecting) || !!store.state.fatalError);
    const update = this.querySelector("[data-update-prompt]");
    update.classList.toggle("hidden", !store.state.updateAvailable || !!store.state.fatalError);
    const prompt = this.querySelector("[data-reload-prompt]");
    prompt.classList.toggle("hidden", !store.state.fatalError);
    if (store.state.fatalError) this.querySelector("[data-reload-message]").textContent = store.state.fatalError;
    if (store.state.filesOpen && store.inProject()) void this.ensureFiles();
  }
}

customElements.define("pi-logs", PiLogs);
customElements.define("pi-confirm", PiConfirm);
customElements.define("pi-session-picker", PiSessionPicker);
customElements.define("pi-settings", PiSettings);
customElements.define("pi-files", PiFiles);
customElements.define("pi-repo-picker", PiRepoPicker);
customElements.define("pi-app", PiApp);
