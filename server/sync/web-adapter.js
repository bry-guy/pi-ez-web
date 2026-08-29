import { randomUUID } from "node:crypto";
import { loadConfig, syncConfig } from "../config.js";
import { clientErrorCode, clientErrorMessage, createSyncClient, loadPiSyncModule, syncExtensionPath } from "./client.js";

const DEFAULT_UI_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_CACHE_MS = 2_000;

function adapterError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function publicError(error, fallback = "The synchronization service is unavailable.") {
  const message = clientErrorMessage(error, fallback);
  return message.length > 300 ? message.slice(0, 300) : message;
}

function cancelValue(method) {
  return method === "confirm" ? false : undefined;
}

function pendingKey(sessionId, requestId) {
  return `${sessionId}:${requestId}`;
}

export class PiSyncWebAdapter {
  constructor({ hub, supervisor, configProvider = null } = {}) {
    this.hub = hub;
    this.supervisor = supervisor;
    this.configProvider = configProvider;
    this.pending = new Map();
    this.store = null;
    this.extensionPathPromise = null;
    this.extensionError = null;
    this.listCache = null;
    this.listPromise = null;
    this.reconcilePromise = null;
    this.connection = this.config().serverUrl ? "available" : "disabled";
    this.lastError = null;
  }

  config() {
    return syncConfig(this.configProvider ? this.configProvider() : loadConfig());
  }

  commandText(text) {
    return text;
  }

  resetExtensionPath() {
    this.extensionPathPromise = null;
    this.extensionError = null;
    this.listCache = null;
    this.connection = this.config().serverUrl ? "unavailable" : "disabled";
    this.lastError = null;
  }

  async extensionPath() {
    if (!this.config().serverUrl) return null;
    if (!this.extensionPathPromise) {
      this.extensionPathPromise = syncExtensionPath().catch(error => {
        this.extensionError = { code: clientErrorCode(error), message: publicError(error, "The pi-sync extension is unavailable.") };
        this.connection = "unavailable";
        this.lastError = this.extensionError;
        return null;
      });
    }
    return this.extensionPathPromise;
  }

  extensionBindings(sessionId) {
    return {
      mode: "json",
      uiContext: this.uiContext(sessionId),
      commandContextActions: this.commandContextActions(sessionId),
      onError: error => {
        this.hub?.emit(sessionId, "extension_error", {
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
        });
      },
    };
  }

  commandContextActions(sessionId) {
    return {
      waitForIdle: async () => { await this.supervisor?.waitForIdle?.(sessionId); },
      newSession: async options => this.supervisor?.newSessionFromCommand?.(sessionId, options) || { cancelled: true },
      fork: async (entryId, options) => this.supervisor?.forkFromCommand?.(sessionId, entryId, options) || { cancelled: true },
      navigateTree: async (targetId, options) => this.supervisor?.navigateTreeFromCommand?.(sessionId, targetId, options) || { cancelled: true },
      switchSession: async (sessionPath, options) => this.supervisor?.switchSessionFromCommand?.(sessionId, sessionPath, options) || { cancelled: true },
      reload: async () => { await this.supervisor?.reloadSession?.(sessionId); },
    };
  }

  uiContext(sessionId) {
    return {
      select: (title, options, opts) => this.request(sessionId, "select", { title, options }, opts, undefined),
      confirm: (title, message, opts) => this.request(sessionId, "confirm", { title, message }, opts, false),
      input: (title, placeholder, opts) => this.request(sessionId, "input", { title, placeholder: placeholder || "" }, opts, undefined),
      notify: (message, type = "info") => {
        this.hub?.emit(sessionId, "extension_ui_notify", { message: String(message || ""), level: type });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.hub?.emit(sessionId, "extension_ui_status", { key, text: text === undefined ? null : String(text) });
        if (key === "pi-sync") {
          this.listCache = null;
          void this.emitSyncState(sessionId);
        }
      },
      setWorkingMessage: message => this.hub?.emit(sessionId, "extension_ui_working", { message: message || null }),
      setWorkingVisible: visible => this.hub?.emit(sessionId, "extension_ui_working", { visible: !!visible }),
      setWorkingIndicator: options => this.hub?.emit(sessionId, "extension_ui_working", { indicator: options || null }),
      setHiddenThinkingLabel: label => this.hub?.emit(sessionId, "extension_ui_thinking", { label: label || null }),
      setWidget: (key, content, options) => {
        if (typeof content === "function") return;
        this.hub?.emit(sessionId, "extension_ui_widget", { key, content: content || null, placement: options?.placement || "aboveEditor" });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: title => this.hub?.emit(sessionId, "extension_ui_title", { title: String(title || "") }),
      custom: async () => undefined,
      pasteToEditor: text => this.hub?.emit(sessionId, "extension_ui_editor", { action: "paste", text: String(text || "") }),
      setEditorText: text => this.hub?.emit(sessionId, "extension_ui_editor", { action: "set", text: String(text || "") }),
      getEditorText: () => "",
      editor: (title, prefill, opts) => this.request(sessionId, "editor", { title, prefill: prefill || "" }, opts, undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: {},
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Browser themes are managed by pi-ez-web." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  request(sessionId, method, payload, options = {}, fallback) {
    const requestId = randomUUID();
    const key = pendingKey(sessionId, requestId);
    const timeout = Number.isFinite(options?.timeout) && options.timeout > 0 ? options.timeout : DEFAULT_UI_TIMEOUT_MS;
    return new Promise(resolve => {
      let timer;
      let onAbort;
      const finish = value => {
        if (!this.pending.has(key)) return;
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        if (options?.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      onAbort = () => finish(fallback);
      if (options?.signal?.aborted) return resolve(fallback);
      if (options?.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(fallback), timeout);
      timer.unref?.();
      this.pending.set(key, {
        sessionId,
        requestId,
        method,
        finish,
        options: Array.isArray(payload.options) ? payload.options.filter(option => typeof option === "string") : null,
      });
      this.hub?.emit(sessionId, "extension_ui_request", {
        requestId,
        method,
        ...payload,
        timeout,
      });
    });
  }

  respond(sessionId, requestId, value) {
    const key = pendingKey(sessionId, requestId);
    const pending = this.pending.get(key);
    if (!pending) throw adapterError("This extension interaction is no longer waiting for a response.", "stale_extension_ui_request");
    const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (body.cancelled === true) {
      pending.finish(cancelValue(pending.method));
      return { ok: true, cancelled: true };
    }
    if (pending.method === "confirm") {
      if (typeof body.confirmed !== "boolean") throw adapterError("A confirmation response is required.", "invalid_extension_ui_response", 400);
      pending.finish(body.confirmed);
      return { ok: true };
    }
    if (pending.method === "select" && (!pending.options || !pending.options.includes(body.value))) {
      throw adapterError("The selected extension UI option is invalid.", "invalid_extension_ui_response", 400);
    }
    if (!["select", "input", "editor"].includes(pending.method) || typeof body.value !== "string") {
      throw adapterError("A text response is required.", "invalid_extension_ui_response", 400);
    }
    pending.finish(body.value);
    return { ok: true };
  }

  cancel(sessionId, requestId) {
    const pending = this.pending.get(pendingKey(sessionId, requestId));
    if (!pending) throw adapterError("This extension interaction is no longer waiting for a response.", "stale_extension_ui_request");
    pending.finish(cancelValue(pending.method));
    return { ok: true, cancelled: true };
  }

  cancelSession(sessionId) {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) pending.finish(cancelValue(pending.method));
    }
  }

  async emitSyncState(sessionId) {
    try { this.hub?.emit(sessionId, "sync_state", { sync: await this.status(sessionId) }); }
    catch { /* status is best effort for UI updates */ }
  }

  async bindingStore() {
    const module = await loadPiSyncModule();
    if (typeof module.BindingStore !== "function") throw adapterError("The installed pi-sync package does not expose bindings.", "sync_client_unavailable", 503);
    if (!this.store) this.store = new module.BindingStore();
    await this.store.load();
    return this.store;
  }

  meaningfulTitle(title, ...placeholders) {
    if (typeof title !== "string") return "";
    const value = title.trim();
    return value && !placeholders.includes(value) ? value : "";
  }

  syncTitle(binding, remote = null) {
    const remoteTitle = remote && this.meaningfulTitle(remote.title, remote.sessionId);
    return remoteTitle || this.meaningfulTitle(binding?.title, binding?.nativeSessionId, binding?.canonicalSessionId) || null;
  }

  async stickyName(sessionId) {
    if (!this.config().serverUrl) return undefined;
    try {
      const binding = await (await this.bindingStore()).get(sessionId);
      const title = binding && this.syncTitle(binding);
      return title || undefined;
    } catch {
      return undefined;
    }
  }

  async list(force = false, serverUrl = this.config().serverUrl) {
    const now = Date.now();
    if (!force && this.listCache?.serverUrl === serverUrl && now - this.listCache.at < STATUS_CACHE_MS) return this.listCache.sessions;
    if (!force && this.listPromise?.serverUrl === serverUrl) return this.listPromise.promise;
    const promise = (async () => {
      try {
        const client = await createSyncClient(serverUrl);
        const response = await client.list();
        this.listCache = { at: Date.now(), serverUrl, sessions: response.sessions || [] };
        this.connection = "available";
        this.lastError = null;
        return this.listCache.sessions;
      } catch (error) {
        this.connection = "unavailable";
        this.lastError = { code: clientErrorCode(error), message: publicError(error) };
        throw error;
      } finally {
        if (this.listPromise?.promise === promise) this.listPromise = null;
      }
    })();
    this.listPromise = { serverUrl, promise };
    return promise;
  }

  syncDetails(binding, remote = null) {
    return {
      syncSessionId: binding.canonicalSessionId,
      syncTitle: this.syncTitle(binding, remote),
      syncWorkspace: remote?.workspace || binding.workspace || null,
    };
  }

  async status(sessionId) {
    const config = this.config();
    if (!config.serverUrl) return { synchronized: false, syncState: "disabled", leaseHolder: null, leaseExpiresAt: null };
    let store;
    try { store = await this.bindingStore(); }
    catch (error) {
      return { synchronized: false, syncState: "error", leaseHolder: null, leaseExpiresAt: null, syncError: { code: error.code || "sync_client_unavailable", message: publicError(error) } };
    }
    const binding = await store.get(sessionId);
    if (!binding) return { synchronized: false, syncState: "pending", leaseHolder: null, leaseExpiresAt: null };
    const details = this.syncDetails(binding);
    if (binding.state === "setup_required") {
      return { synchronized: true, ...details, syncState: "error", leaseHolder: null, leaseExpiresAt: null, syncError: { code: "sync_session_not_found", message: "The sync server no longer has this conversation." } };
    }
    try {
      const remote = (await this.list(false, binding.serverUrl || config.serverUrl)).find(item => item.sessionId === binding.canonicalSessionId);
      if (!remote) {
        return { synchronized: true, ...details, syncState: "error", leaseHolder: null, leaseExpiresAt: null, syncError: { code: "sync_session_not_found", message: "The sync server no longer has this conversation." } };
      }
      return {
        synchronized: true,
        ...this.syncDetails(binding, remote),
        syncState: remote.leaseHolder || binding.leaseToken ? "in_use" : "available",
        leaseHolder: remote.leaseHolder || null,
        leaseExpiresAt: remote.leaseExpiresAt || null,
      };
    } catch (error) {
      return {
        synchronized: true,
        ...details,
        syncState: "error",
        leaseHolder: null,
        leaseExpiresAt: null,
        syncError: { code: clientErrorCode(error), message: publicError(error) },
      };
    }
  }

  state() {
    const config = this.config();
    return {
      version: 1,
      configured: !!config.serverUrl,
      enabled: !!config.serverUrl,
      serverUrl: config.serverUrl,
      allConversations: config.allConversations,
      connection: !config.serverUrl ? "disabled" : this.connection,
      implementation: config.serverUrl ? "extension" : "unavailable",
      error: this.extensionError || this.lastError,
    };
  }

  assertConfigurationChangeAllowed() {}

  async enroll(sessionId) {
    const config = this.config();
    if (!config.serverUrl) throw adapterError("Configure a sync server before enrolling conversations.", "sync_not_configured");
    if (!await this.extensionPath()) throw adapterError("The pi-sync extension is not installed on this server.", "sync_client_unavailable", 503);
    const before = await this.status(sessionId);
    await this.supervisor.command(sessionId, "/sync attach");
    this.listCache = null;
    const after = await this.status(sessionId);
    if (!after.synchronized) {
      const code = after.syncError?.code || "sync_enrollment_failed";
      throw adapterError(after.syncError?.message || "The conversation could not be synchronized.", code, code === "sync_duplicate" ? 409 : 502);
    }
    return { ok: true, created: !before.synchronized, ...after };
  }

  async refresh(sessionId) {
    const config = this.config();
    if (!config.serverUrl) throw adapterError("Configure a sync server before refreshing conversations.", "sync_not_configured");
    if (!await this.extensionPath()) throw adapterError("The pi-sync extension is not installed on this server.", "sync_client_unavailable", 503);
    await this.supervisor.command(sessionId, "/sync refresh");
    this.listCache = null;
    const status = await this.status(sessionId);
    if (!status.synchronized) throw adapterError(status.syncError?.message || "The conversation could not be refreshed.", status.syncError?.code || "sync_session_not_found");
    return { ok: true, ...status };
  }

  async reconcile() {
    if (!this.config().allConversations || !this.config().serverUrl) return;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      try {
        for (const session of await this.supervisor?.allSessions?.() || []) {
          const status = await this.status(session.id);
          if (status.synchronized) continue;
          try { await this.enroll(session.id); } catch { /* a later reconciliation can retry */ }
        }
      } catch { /* startup reconciliation is best effort */ }
      finally { this.reconcilePromise = null; }
    })();
    return this.reconcilePromise;
  }

  async sessionCreated(sessionId) {
    if (this.config().allConversations) void this.enroll(sessionId).catch(() => undefined);
  }

  async withMutation(_sessionId, task) { return task(); }
  async beginMutation() { return { managed: false }; }
  async release() { return { ok: true }; }
  async agentSettled() { return { ok: true }; }
  async commitSettled() { return { managed: false }; }
  async commitAndRelease() { return { managed: false }; }
  async close() {
    for (const pending of this.pending.values()) pending.finish(cancelValue(pending.method));
  }
}
