import { api, refreshState } from "./api.js";
import { beginOperation, completeOperation } from "./operations.js";
import { setHTML, store } from "./store.js";
import { esc } from "./shell.js";
import { operationFeedback } from "./panel-utils.js";


/* ---------------- settings ---------------- */
class PiSettings extends HTMLElement {
  connectedCallback() {
    this.feedback = null;
    this.drafts = new Map();
    this.detailsOpen = new Map();
    this.resettingInteraction = true;
    this.settingsOpen = store.state.view === "settings";
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.view === "settings"
        && !store.state.logsOpen && !store.state.repoPickerOpen && !store.state.sessionPicker
        && !store.state.confirm && !store.state.extensionUi) {
        e.preventDefault();
        store.set({ view: "chat" });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.unsub = store.subscribe(w => {
      if (w !== "state") return;
      const settingsOpen = store.state.view === "settings";
      if (settingsOpen !== this.settingsOpen) {
        this.resetDrafts();
        this.resettingInteraction = true;
        this.__html = null;
      }
      this.settingsOpen = settingsOpen;
      this.render();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("input", e => this.trackDraft(e.target));
    this.addEventListener("change", e => {
      this.trackDraft(e.target);
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
    this.resetDrafts();
    this.resettingInteraction = true;
    this.settingsOpen = false;
    this.__html = null;
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
    clearTimeout(this.flowTimer);
    clearTimeout(this.feedbackTimer);
  }
  resetDrafts() {
    this.drafts = new Map();
    this.detailsOpen = new Map();
  }
  settingKey(control) {
    if (control?.matches?.(".repos-root-input")) return "reposRoot";
    if (control?.matches?.("[data-setting]") && !control.matches("[data-auth-input]")) return control.dataset.setting;
    return null;
  }
  settingControl(key) {
    return [...this.querySelectorAll("[data-setting], .repos-root-input")].find(control => this.settingKey(control) === key);
  }
  settingValue(control) {
    return control.type === "checkbox" ? control.checked : control.value;
  }
  trackDraft(control) {
    const key = this.settingKey(control);
    if (key && !control.disabled) this.drafts.set(key, this.settingValue(control));
  }
  captureDrafts() {
    for (const key of this.drafts.keys()) {
      const control = this.settingControl(key);
      if (control) this.drafts.set(key, this.settingValue(control));
    }
  }
  snapshotDrafts(keys) {
    const values = new Map();
    for (const key of keys) {
      const control = this.settingControl(key);
      if (control) values.set(key, this.settingValue(control));
    }
    return { drafts: this.drafts, values };
  }
  clearDrafts(snapshot) {
    if (!snapshot || snapshot.drafts !== this.drafts) return;
    this.captureDrafts();
    let changed = false;
    for (const [key, value] of snapshot.values) {
      if (this.drafts.has(key) && Object.is(this.drafts.get(key), value)) {
        this.drafts.delete(key);
        changed = true;
      }
    }
    if (changed) this.__html = null;
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
    if (e.target.closest("[data-act='close-settings']")) { store.set({ view: "chat" }); return; }
    if (e.target.closest("[data-act='open-logs']")) { store.set({ logsOpen: true, logsError: null }); return; }
    const theme = e.target.closest("[data-theme-choice]");
    if (theme) {
      const value = theme.dataset.themeChoice;
      document.documentElement.dataset.theme = value;
      try { localStorage.setItem("pi-theme", value); } catch { /* storage is optional */ }
      for (const b of this.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b === theme));
      return;
    }
    if (e.target.closest("[data-act='save-repos-root']")) return this.saveReposRoot();
    if (e.target.closest("[data-act='save-repository-settings']")) return this.saveRepositorySettings();
    if (e.target.closest("[data-act='save-sync-settings']")) return this.saveSyncSettings();
    if (e.target.closest("[data-act='save-pi-configuration']")) return this.savePiConfiguration();
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
    const snapshot = this.snapshotDrafts(["reposRoot"]);
    const value = input.value.trim() || null;
    const previous = store.state.reposRoot;
    try {
      const result = await api.settings(undefined, value);
      store.set({ reposRoot: result.reposRoot || null, reposRootSource: result.reposRootSource || "default", repos: [] });
      this.clearDrafts(snapshot);
      this.setFeedback("Repository path saved.");
    } catch (err) {
      store.set({ reposRoot: previous });
      this.setFeedback(`Repository path failed: ${err.error || err.message || err}`, "error");
    }
  }
  async saveDefaultThinking(level) {
    const snapshot = this.snapshotDrafts(["defaultThinkingLevel"]);
    const previous = store.state.defaultThinkingLevel;
    try {
      const result = await api.settingsPatch({ defaultThinkingLevel: level });
      store.set({ defaultThinkingLevel: result.defaultThinkingLevel || level });
      this.clearDrafts(snapshot);
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
    const snapshot = this.snapshotDrafts(Object.keys(patch.sync).map(key => key === "serverUrl" ? "syncServerUrl" : "syncAllConversations"));
    try {
      await api.settingsPatch(patch);
      await refreshState();
      this.clearDrafts(snapshot);
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
    const snapshot = this.snapshotDrafts(Object.keys(patch));
    try {
      await api.settingsPatch(patch);
      await refreshState();
      this.clearDrafts(snapshot);
      this.setFeedback("Repository settings saved.");
    } catch (err) {
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
      profileSource: profile ? "explicit" : current.profileSource === "disabled" ? "disabled" : "auto",
      packages: lines("[data-setting='piPackages']"),
      extensions: lines("[data-setting='piExtensions']"),
    };
    const snapshot = this.snapshotDrafts(["piProfile", "piPackages", "piExtensions"]);
    await this.applyPiConfiguration(pi, "applied", snapshot);
  }
  async applyPiConfiguration(pi, verb, snapshot) {
    const operation = beginOperation("pi-profile", "Apply Pi resources", "", "Request started.");
    try {
      const result = await api.settingsPatch({ pi, operationId: operation.id, activeSessionId: store.activeKey() });
      completeOperation(operation, result);
      const profileError = result.piConfiguration?.profile?.error;
      try {
        await refreshState();
        if (!profileError) this.clearDrafts(snapshot);
      } catch (err) {
        store.setError(`Could not refresh Pi resource state: ${err.message || err}`);
      }
      const message = profileError
        ? `Pi configuration ${verb}, but the profile could not be loaded: ${profileError}`
        : `Pi profile ${verb}. Resources are active for the selected session and load for other sessions when they open.`;
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
    const name = provider.id === "openai-codex"
      ? "OpenAI — ChatGPT"
      : provider.id === "openai"
        ? "OpenAI — API"
        : provider.name;
    const status = provider.configured
      ? `Connected${provider.sourceLabel ? ` · ${provider.sourceLabel}` : ""}`
      : "Not connected";
    const models = provider.availableModels || 0;
    const login = provider.source === "environment" ? "" : provider.authMethods?.map(method => {
      const label = provider.id === "openai-codex" && method.id === "oauth"
        ? "Sign in with ChatGPT"
        : provider.id === "anthropic" && method.id === "oauth"
          ? "Sign in with Anthropic"
          : method.id === "api_key"
            ? `Use ${provider.id === "openai" ? "OpenAI" : provider.id === "anthropic" ? "Anthropic" : name} API key`
            : method.label;
      return `<button class="settings-action" data-auth-login="${esc(provider.id)}" data-auth-type="${esc(method.id)}">${esc(provider.configured ? `Reconnect · ${label}` : label)}</button>`;
    }).join("") || "";
    const logout = provider.canLogout
      ? `<button class="settings-action quiet" data-auth-logout="${esc(provider.id)}">Disconnect</button>` : "";
    return `<div class="settings-card provider-card">
      <div class="provider-card-head">
        <div><div class="sr-title">${esc(name)}</div><div class="sr-sub">${esc(status)} · ${models} available model${models === 1 ? "" : "s"}</div></div>
        <span class="status-dot ${provider.configured ? "" : "off"}" aria-label="${provider.configured ? "Connected" : "Not connected"}"></span>
      </div>
      ${provider.error ? `<div class="provider-error">${esc(provider.error.message || "Provider status unavailable.")}</div>` : ""}
      <div class="provider-actions">${login}${logout || (!login ? `<span class="provider-action-note">No browser login available</span>` : "")}</div>
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
    return `<div class="auth-flow-card" data-auth-flow-id="${esc(flow.id || "")}" data-auth-prompt-id="${esc(flow.prompt?.id || "")}" role="dialog" aria-label="Provider login">
      <div class="auth-flow-head"><strong>Provider login</strong><button class="ghost-btn" data-auth-cancel aria-label="Cancel login">×</button></div>
      ${notification}
      ${flow.prompt ? `<div class="auth-prompt"><label>${esc(flow.prompt.message)}</label>${prompt}<button class="settings-save" data-auth-submit>Submit</button></div>` : ""}
      ${flow.state === "pending" ? `<div class="auth-note">Waiting for provider…</div>` : ""}
      ${flow.error ? `<div class="provider-error">${esc(flow.error.message)}</div>` : ""}
    </div>`;
  }
  render() {
    const providers = store.state.providers || [];
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
    const profileInputValue = piConfig.profile || "";
    const profileStatus = ["loaded", "cached"].includes(piState.profile?.status)
      ? `${piState.profile.status === "cached" ? "Using cached" : "Loaded"} ${piState.profile.source}${piState.profile.ref ? ` @ ${piState.profile.ref}` : ""}${piState.profile.commit ? ` · ${piState.profile.commit.slice(0, 12)}` : ""}`
      : piState.profile?.status === "error"
        ? `Profile error: ${piState.profile.error}`
        : "Using the deployment's Pi settings";
    const loadedExtensions = Array.isArray(piState.runtime?.extensions) ? piState.runtime.extensions : [];
    const loadedSkills = Array.isArray(piState.runtime?.skills) ? piState.runtime.skills : [];
    const resourceRows = (items, empty) => items.length
      ? `<ul>${items.map(item => `<li><strong>${esc(item.name || "Unnamed resource")}</strong><span>${esc(item.path || "")}</span><small>${esc([item.source, item.scope, item.origin].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul>`
      : `<div class="pi-resource-empty">${esc(empty)}</div>`;
    const extensionList = piState.runtime
      ? `<details class="pi-loaded-list" data-settings-details="extensions"><summary>Loaded extensions (${loadedExtensions.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedExtensions, "No extensions loaded.")}</div></details>`
      : "";
    const skillList = piState.runtime
      ? `<details class="pi-loaded-list" data-settings-details="skills"><summary>Loaded skills (${loadedSkills.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedSkills, "No skills loaded.")}</div></details>`
      : "";
    const skillCount = Array.isArray(piState.runtime?.skills) ? loadedSkills.length : (piState.runtime?.skills || 0);
    const packageStatus = piState.runtime?.packageStatus;
    const packageSummary = packageStatus?.configured
      ? ` ${packageStatus.loaded} of ${packageStatus.configured} configured package${packageStatus.configured === 1 ? "" : "s"} active${packageStatus.failed ? `; ${packageStatus.failed} skipped` : ""}.`
      : "";
    const runtimeSummary = piState.runtime
      ? `${loadedExtensions.length} extension${loadedExtensions.length === 1 ? "" : "s"}, ${skillCount} skill${skillCount === 1 ? "" : "s"}, and ${piState.runtime.prompts || 0} prompts loaded${piState.runtime.loadedAt ? ` at ${new Date(piState.runtime.loadedAt).toLocaleTimeString()}` : ""}.${packageSummary}`
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
    const piOperation = operationFeedback("pi-profile", "Applying Pi resources…");
    const githubSummary = githubStatus?.authenticated
      ? `Connected${githubStatus.account?.login ? ` as ${githubStatus.account.login}` : ""}`
      : githubStatus?.configured ? "Not connected" : "Sign-in requires server GitHub app setup";
    const preserveInteraction = !this.resettingInteraction;
    this.resettingInteraction = false;
    if (preserveInteraction) this.captureDrafts();
    const active = preserveInteraction ? this.ownerDocument.activeElement : null;
    const focusKey = this.contains(active) ? this.settingKey(active) : null;
    const selection = focusKey && typeof active.selectionStart === "number"
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    if (preserveInteraction) {
      for (const details of this.querySelectorAll("details[data-settings-details]")) {
        this.detailsOpen.set(details.dataset.settingsDetails, details.open);
      }
    }
    const html = `<div class="col-pad">
      <div class="screen-title-row"><div class="screen-title">Settings</div><div class="settings-title-actions"><button class="ghost-btn settings-close" data-act="close-settings" title="Close settings" aria-label="Close settings">×</button></div></div>
      ${feedback}
      <section class="settings-section">
        <div class="settings-section-title">Appearance</div>
        <div class="settings-card settings-card-spaced"><div class="settings-row">
          <div class="sr-main"><div class="sr-title">Theme</div><div class="sr-sub">Stored in this browser.</div></div>
          <div class="segmented" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => `<button data-theme-choice="${value}" aria-pressed="${(document.documentElement.dataset.theme || "system") === value}">${label}</button>`).join("")}</div>
        </div></div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">AI providers</div>
        <div class="provider-list">${providers.map(provider => this.providerCard(provider)).join("") || `<div class="modal-empty">No provider status available.</div>`}</div>
      </section>
      ${this.authFlowCard()}
      <section class="settings-section">
        <div class="settings-section-title">Pi profile & extensions</div>
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Pi profile</div><div class="sr-sub">Optional: enter a local path or HTTPS URL. Leave blank to use only the deployment's Pi settings. GitHub profiles read <span class="settings-mono">.pi/agent/settings.json</span> and supported resources.</div></div>
            <input class="settings-inline-input pi-profile-input" data-setting="piProfile" value="${esc(profileInputValue)}" placeholder="https://github.com/owner/dotfiles">
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Additional packages</div><div class="sr-sub">Optional packages added on top of the profile. Enter one Pi npm/git package source per line; missing packages install on Apply.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piPackages" rows="4" placeholder="npm:context-mode&#10;git:github.com/owner/pi-extension">${esc((piConfig.packages || []).join("\n"))}</textarea>
          </div>
          <details class="settings-advanced" data-settings-details="advanced" ${(piConfig.extensions || []).length ? "open" : ""}><summary>Advanced</summary><div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Local extension paths</div><div class="sr-sub">Optional server-local extension files or directories, one path per line. These are not package names; relative paths resolve from <span class="settings-mono">PI_WEB_HOME</span>.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piExtensions" rows="4" placeholder="/data/extensions/my-extension.ts">${esc((piConfig.extensions || []).join("\n"))}</textarea>
          </div></details>
          <div class="settings-row pi-resource-status"><div class="sr-main"><div class="sr-title">${esc(profileStatus)}</div><div class="sr-sub">${esc(runtimeSummary)}</div>${extensionList}${skillList}${piProblems.length ? `<div class="provider-error">${piProblems.map(esc).join(" · ")}</div>` : ""}</div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">Apply fetches the profile, installs missing packages, and reloads idle sessions. Remote extensions execute with the server user's full permissions.</span><div class="settings-actions"><button class="settings-save" data-act="save-pi-configuration">Apply</button>${piOperation}</div></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Conversation synchronization</div>
        <div class="settings-card settings-card-spaced">
          ${syncServerEditable ? `<div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Sync server</div><div class="sr-sub">Canonical enrolled conversations live in the configured pi-sync service. Leave this empty to keep local-only behavior.</div></div>
            <input class="settings-inline-input" data-setting="syncServerUrl" value="${esc(syncServerUrl)}" placeholder="https://pi-sync.example">
          </div>` : ""}
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Synchronize all conversations</div><div class="sr-sub">${syncAllEditable ? "Enroll every conversation automatically. Otherwise use <span class=\"settings-mono\">/sync</span> in a conversation." : "Set by the deployment. Use <span class=\"settings-mono\">/sync</span> to enroll a conversation."}</div></div>
            <label class="sync-toggle"><input type="checkbox" data-setting="syncAllConversations" ${syncAll ? "checked" : ""} ${syncAllEditable ? "" : "disabled"}><span>${syncAll ? "On" : "Off"}</span></label>
          </div>
          <div class="settings-row"><div class="sr-main"><div class="sr-title">${esc(syncLabel)}</div><div class="sr-sub">${syncState.implementation === "fake" ? "Using the development coordinator; no network calls are made." : esc(syncState.error?.message || syncServerUrl)}</div></div><span class="status-dot ${syncState.connection === "available" ? "" : "off"}"></span></div>
          ${syncServerEditable || syncAllEditable ? `<div class="settings-row settings-actions-row"><span></span><button class="settings-save" data-act="save-sync-settings">Save</button></div>` : ""}
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
          <div class="settings-row settings-actions-row"><span class="settings-mono">${sourceEditable && ownerEditable ? "Stored in config.json" : "One or more values are environment-controlled"}</span><div class="settings-actions"><button class="settings-save" data-act="save-repository-settings" ${sourceEditable || ownerEditable ? "" : "disabled"}>Save</button></div></div>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Defaults</div>
      <div class="settings-card settings-card-spaced">
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
        ${store.state.reposRootSource === "environment" ? "" : `<div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Local repositories</div><div class="sr-sub">Folder scanned by the project picker. Empty uses <span class="settings-mono">~/src</span>${store.state.reposRootSource === "environment" ? ". <span class=\"settings-mono\">PI_WEB_REPOS_ROOT</span> currently overrides this value" : ""}.</div></div>
          <div class="settings-path-control">
            <input class="repos-root-input" aria-label="Local repositories path" value="${esc(store.state.reposRoot || "")}" placeholder="~/src">
            <button class="settings-save" data-act="save-repos-root">Save</button>
          </div>
        </div>`}
      </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Diagnostics</div>
        <div class="settings-card settings-card-spaced"><div class="settings-row"><div class="sr-main"><div class="sr-title">Server logs</div><div class="sr-sub">Recent operations and server output.</div></div><button class="settings-action" data-act="open-logs">Open logs</button></div></div>
      </section>
    </div>`;
    setHTML(this, html);
    for (const [key, value] of this.drafts) {
      const control = this.settingControl(key);
      if (!control || control.disabled) continue;
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
    }
    for (const details of this.querySelectorAll("details[data-settings-details]")) {
      const key = details.dataset.settingsDetails;
      if (this.detailsOpen.has(key)) details.open = this.detailsOpen.get(key);
    }
    if (focusKey) {
      const control = this.settingControl(focusKey);
      if (control && !control.disabled) {
        if (control !== active) control.focus({ preventScroll: true });
        if (selection && typeof control.setSelectionRange === "function") {
          control.setSelectionRange(selection.start, selection.end, selection.direction);
        }
      }
    }
  }
}

customElements.define("pi-settings", PiSettings);
