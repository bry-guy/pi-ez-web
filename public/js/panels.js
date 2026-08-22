import { api, refreshState } from "./api.js";
import { store } from "./store.js";
import { esc, mobile, selectSession } from "./shell.js";

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
        : `Synchronization settings failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async saveRepositorySettings() {
    const patch = {};
    if (store.state.settings?.defaultRepositorySource?.editable !== false) patch.defaultRepositorySource = this.querySelector("[data-setting='defaultRepositorySource']")?.value;
    if (store.state.settings?.githubOwner?.editable !== false) patch.githubOwner = this.querySelector("[data-setting='githubOwner']")?.value.trim() || null;
    if (!Object.keys(patch).length) return;
    try {
      await api.settingsPatch(patch);
      await refreshState();
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
    const pi = {
      profile: this.querySelector("[data-setting='piProfile']")?.value.trim() || null,
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
    try {
      const result = await api.settingsPatch({ pi });
      await refreshState();
      const profileError = result.piConfiguration?.profile?.error;
      const message = profileError
        ? `Pi configuration ${verb}, but the profile could not be loaded: ${profileError}`
        : `Pi profile ${verb}. Packages and skills reload when a session loads.`;
      this.setFeedback(message, profileError ? "error" : "success");
    } catch (err) {
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
      ? `${piState.profile.status === "cached" ? "Using cached" : "Loaded"} ${piState.profile.source}`
      : piState.profile?.status === "error"
        ? `Profile error: ${piState.profile.error}`
        : "Using the deployment's Pi settings";
    const loadedSkills = Array.isArray(piState.runtime?.skills) ? piState.runtime.skills : [];
    const skillList = loadedSkills.length
      ? `<details class="pi-skill-list"><summary>Loaded skills (${loadedSkills.length})</summary><ul>${loadedSkills.map(skill => `<li><strong>${esc(skill.name || "Unnamed skill")}</strong><span>${esc(skill.path || "")}</span></li>`).join("")}</ul></details>`
      : "";
    const skillCount = Array.isArray(piState.runtime?.skills) ? loadedSkills.length : (piState.runtime?.skills || 0);
    const runtimeSummary = piState.runtime
      ? `${piState.runtime.extensions?.length || 0} extension${piState.runtime.extensions?.length === 1 ? "" : "s"}, ${skillCount} skill${skillCount === 1 ? "" : "s"}, and ${piState.runtime.prompts || 0} prompts loaded for the last attached session.`
      : "Resources load in the background when a session is first opened.";
    const piProblems = [...(piState.warnings || []), ...(piState.runtime?.errors || []).map(error => `${error.path}: ${error.error}`)];
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const defaultThinkingLevel = store.state.defaultThinkingLevel || "medium";
    const feedback = this.feedback
      ? `<div class="settings-feedback ${this.feedback.kind === "error" ? "error" : ""}" role="status">${esc(this.feedback.message)}</div>`
      : "";
    const githubSummary = githubStatus?.authenticated
      ? `Connected${githubStatus.account?.login ? ` as ${githubStatus.account.login}` : ""}`
      : githubStatus?.configured ? "Not connected" : "Sign-in requires server GitHub app setup";
    this.innerHTML = `<div class="col-pad">
      <div class="screen-title">Settings</div>
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
            <div class="sr-main"><div class="sr-title">Profile settings</div><div class="sr-sub">Optional profile directory, settings.json path, or HTTPS URL. A GitHub repository URL reads <span class="settings-mono">.pi/agent/settings.json</span>. Credentials and transcripts stay local to this deployment.</div></div>
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
          <div class="settings-row pi-resource-status"><div class="sr-main"><div class="sr-title">${esc(profileStatus)}</div><div class="sr-sub">${esc(runtimeSummary)}</div>${skillList}${piProblems.length ? `<div class="provider-error">${piProblems.map(esc).join(" · ")}</div>` : ""}</div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">Remote extensions execute with the server user's full permissions.</span><div class="settings-actions"><button class="settings-action quiet" data-act="refresh-pi-configuration">Refresh profile</button><button class="settings-save" data-act="save-pi-configuration">Save & reload</button></div></div>
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
          <div class="settings-row settings-actions-row"><span class="settings-mono">${sourceEditable && ownerEditable ? "Stored in config.json" : "One or more values are environment-controlled"}</span><button class="settings-save" data-act="save-repository-settings" ${sourceEditable || ownerEditable ? "" : "disabled"}>Save</button></div>
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

  currentBranch() {
    const project = store.project();
    const node = store.findSession(store.state.sessionId);
    return node?.branch || project?.branch || null;
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
    return Array.isArray(targets) && targets.length
      ? targets
      : ["none", "HEAD", ...((store.project()?.branches || []).includes("main") ? ["main"] : [])];
  }

  targetLabel(target) {
    return target === "none" ? "No diff" : target;
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
    const branch = this.currentBranch();
    if (!projectId || !branch || !filePath) return;
    if (!this.availableTargets().includes(target)) target = "none";
    const requestId = ++this.requestId;
    store.set({ filePath, fileView: null, fileTarget: target, fileLoading: true, fileError: null });
    try {
      const view = await api.file(projectId, branch, filePath, target);
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
      selectSession(result.id, result.sessionId);
      store.set({ hookResult: result.setup || null, workspaceSettingsOpen: result.setup && !result.setup.ok });
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
          this.githubFlow = null;
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

/* ---------------- confirmation modal (merge / close) ---------------- */
class PiConfirm extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => {
      const scrim = this.querySelector(".confirm-scrim");
      if (e.target === scrim || e.target.closest("[data-act='cancel']")) {
        store.set({ confirm: null });
      } else if (e.target.closest("[data-act='navigate-session']")) {
        const id = e.target.closest("[data-act='navigate-session']")?.dataset.id;
        const p = store.project();
        if (p && id) selectSession(p.id, id);
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
        merge_rehome_failed: "the merge landed, but one session could not be moved; the worktree was kept",
        merge_cleanup_failed: "the merge landed, but cleanup failed; check Workspace settings for the remaining worktree",
        main_worktree_external: "main is checked out by another worktree; remove that worktree outside the app first",
        return_rehome_failed: "main is ready, but this session could not be moved to the checkout",
        sessions_active: "stop the active sessions before merging",
      };
      store.set(s => ({ confirm: { ...s.confirm, error: msgs[err.error] || err.error || "failed" } }));
    }
  }

  render() {
    const c = store.state.confirm;
    if (!c) { this.innerHTML = ""; return; }
    const p = store.project();
    const target = "main";
    const isMerge = c.type === "merge";
    const active = (c.sessions || []).filter(session => session.streaming || store.transcript(session.id).streaming);
    const checkoutBranch = p?.branch && p.branch !== target ? ` The checkout will switch from ${esc(p.branch)} to ${target} first.` : "";
    const title = isMerge ? "Merge to main" : c.kind === "chat" ? "Close chat" : "Close session";
    const body = isMerge
      ? `Merge ${esc(c.branch)} into ${target}.${checkoutBranch} All sessions using this worktree will move to the repository checkout on ${target}.`
        + (active.length ? `<div class="confirm-sessions"><strong>Active sessions will be interrupted:</strong>${active.map(session => `<button data-act="navigate-session" data-id="${esc(session.id)}">${esc(session.title)}</button>`).join("")}</div>` : "")
      : `“${esc(c.label)}” will be closed and removed from the list. Its transcript stays in session storage.`;
    const warn = isMerge
      ? `The worktree and branch will be removed. Any uncommitted worktree changes will be lost.`
      : c.externalMain
        ? "This is an external main worktree. Closing archives this session but leaves the protected worktree in place."
        : !isMerge && c.branch && c.branch !== target
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
          <div class="screen" data-screen="settings"><div class="scrollable"><pi-settings></pi-settings></div></div>
        </main>
        <pi-files></pi-files>
        <div class="drawer-scrim hidden"></div>
        <div class="connection-status hidden" data-connection-status></div>
        <div class="update-prompt hidden" data-update-prompt>
          <span>New pi update ready.</span><button class="update-btn" data-act="update">Reload</button>
        </div>
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
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    window.removeEventListener("resize", this.onResize);
  }

  filesKey() {
    const p = store.project();
    if (!p || !store.inProject()) return null;
    const node = store.findSession(store.state.sessionId);
    return `${p.id}:${node?.workspacePath || node?.branch || p.branch || ""}:${store.state.fileTarget}`;
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
      const result = await api.files(store.state.projectId, node?.branch, store.state.fileTarget);
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

customElements.define("pi-confirm", PiConfirm);
customElements.define("pi-settings", PiSettings);
customElements.define("pi-files", PiFiles);
customElements.define("pi-repo-picker", PiRepoPicker);
customElements.define("pi-app", PiApp);
