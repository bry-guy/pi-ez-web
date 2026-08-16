import { api, refreshState } from "./api.js";
import { store } from "./store.js";
import { esc, mobile, selectSession } from "./shell.js";

/* ---------------- settings ---------------- */
class PiSettings extends HTMLElement {
  connectedCallback() {
    this.feedback = null;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
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
    const invalidModes = store.state.projects.filter(project => project.modeInvalid);
    const modeWarning = invalidModes.length
      ? `<div class="settings-warning">Invalid project mode for ${esc(invalidModes.map(project => project.name).join(", "))}; using manual mode. Edit config.json to set <span class="settings-mono">mode: manual</span> or <span class="settings-mono">mode: auto</span>.</div>`
      : "";
    const providers = (store.state.providers || []).filter(provider => provider.id !== "openai" || provider.configured);
    const settings = store.state.settings || {};
    const source = settings.defaultRepositorySource?.value || store.state.repositorySources?.default || "local";
    const sourceEditable = settings.defaultRepositorySource?.editable !== false;
    const owner = settings.githubOwner?.value || "";
    const ownerEditable = settings.githubOwner?.editable !== false;
    const githubStatus = store.state.repositorySources?.sources?.find(source => source.id === "github");
    const feedback = this.feedback
      ? `<div class="settings-feedback ${this.feedback.kind === "error" ? "error" : ""}" role="status">${esc(this.feedback.message)}</div>`
      : "";
    const githubSummary = githubStatus?.authenticated
      ? `Connected${githubStatus.account?.login ? ` as ${githubStatus.account.login}` : ""}`
      : githubStatus?.configured ? "Not connected" : "Sign-in requires server GitHub app setup";
    this.innerHTML = `<div class="col-pad">
      <div class="screen-title">Settings</div>
      ${feedback}
      ${modeWarning}
      <section class="settings-section">
        <div class="settings-section-title">AI providers</div>
        <div class="provider-list">${providers.map(provider => this.providerCard(provider)).join("") || `<div class="modal-empty">No provider status available.</div>`}</div>
      </section>
      ${this.authFlowCard()}
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
      store.set({ hookResult: result.setup || null });
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
      if (c.type === "bind") {
        await api.branch(c.id, c.branch, true);
        await refreshState();
        store.set({ confirm: null, draft: c.text });
        document.querySelector("pi-composer")?.send(c.mode);
        return;
      }
      if (c.type === "merge") await api.merge(c.id);
      else await api.close(c.id);
      store.set({ confirm: null });
    } catch (err) {
      const msgs = {
        merge_conflict: "merge conflict — the checkout was restored; resolve by hand or keep working",
        workspace_dirty: "worktree has uncommitted changes — commit them first",
        checkout_dirty: "the project checkout has uncommitted changes",
        session_streaming: "session is mid-turn — stop it first",
        branch_occupied: "that branch is already in use",
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
    const isBind = c.type === "bind";
    const title = isBind ? "Continue on a new branch?" : isMerge ? "Merge branch" : c.kind === "chat" ? "Close chat" : "Close session";
    const body = isBind
      ? `${esc(c.fromBranch || target)} is in use by <strong>${esc(c.byTitle || "another session")}</strong>. Continue on ${esc(c.branch)}?`
      : isMerge
        ? `Merge ${esc(c.branch)} into ${esc(target)}. The session stays open and continues on ${esc(target)}.`
        : `“${esc(c.label)}” will be closed and removed from the list. Its transcript stays in session storage.`;
    const warn = !isBind && !isMerge && c.branch && c.branch !== target
      ? `The worktree for ${esc(c.branch)} will be removed. Any changes on this branch will be lost.` : "";
    const cta = isBind ? "Continue" : isMerge ? "Merge" : c.kind === "chat" ? "Close chat" : "Close session";
    this.innerHTML = `<div class="confirm-scrim">
      <div class="confirm-modal">
        <div class="confirm-title">${title}</div>
        <div class="confirm-body">${body}</div>
        ${warn ? `<div class="confirm-warn">${warn}</div>` : ""}
        ${c.error ? `<div class="confirm-error">${esc(c.error)}</div>` : ""}
        <div class="confirm-actions">
          <button class="confirm-back" data-act="cancel">Go back</button>
          <button class="confirm-cta ${isMerge || isBind ? "accent" : "danger"}" data-act="go">${cta}</button>
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
        <div class="connection-status hidden" data-connection-status>Reconnecting to pi-ez-web…</div>
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
    const connection = this.querySelector("[data-connection-status]");
    connection.classList.toggle("hidden", !store.state.reconnecting || !!store.state.fatalError);
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
