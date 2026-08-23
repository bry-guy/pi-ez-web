import os from "node:os";
import { loadConfig, syncConfig } from "../config.js";
import { isSyncEnrolled, markSyncEnrolled, markSyncPending } from "./enrollment.js";
import { clientErrorCode, clientErrorMessage, createSyncClient, isTransportError, syncSkillPath } from "./client.js";
import {
  deriveWorkspacePointer,
  materializeSessionFile,
  normalizeSessionFile,
  stableEnvelopeFingerprint,
} from "./session-files.js";
import { verifyWorkspacePointer } from "./workspace.js";

export const SYNC_CAPABILITY_VERSION = 1;
const STATUS_CACHE_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;

const HTTP_STATUS = {
  active_lease: 423,
  sync_lease_uncertain: 423,
  sync_conflict: 409,
  sync_stale_etag: 409,
  sync_not_configured: 409,
  sync_not_enrolled: 409,
  sync_duplicate: 409,
  session_streaming: 409,
  session_compacting: 409,
  sync_materialization_failed: 409,
  sync_workspace_setup_required: 409,
  sync_client_unavailable: 503,
  sync_unavailable: 503,
  sync_session_not_found: 409,
  sync_enrollment_failed: 502,
  sync_active: 409,
};

export function syncError(message, code, extra = {}) {
  return Object.assign(new Error(message), {
    code,
    status: extra.status ?? HTTP_STATUS[code],
    ...extra,
  });
}

function configFor(provider) {
  try { return syncConfig(provider?.()); } catch { return syncConfig(loadConfig()); }
}

function statusFor(config, enrolled, extra = {}) {
  if (!config.serverUrl) return { synchronized: false, ...extra };
  return {
    synchronized: !!enrolled,
    syncState: enrolled ? "available" : "pending",
    leaseHolder: null,
    leaseExpiresAt: null,
    ...extra,
  };
}

function safeMessage(error, fallback) {
  const message = clientErrorMessage(error, fallback);
  return message.length > 300 ? message.slice(0, 300) : message;
}

function isMissingSession(error) {
  return error?.code === "session_not_found" || error?.code === "sync_session_not_found";
}

function isLeaseFailure(error) {
  return ["lease_required", "lease_invalid", "lease_not_found", "active_lease"].includes(error?.code);
}

function isSessionId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

class BaseCoordinator {
  constructor({ supervisor = null, config = null, configProvider = null } = {}) {
    this.supervisor = supervisor;
    this.initialConfig = config;
    this.configProvider = configProvider;
    this.mutationQueues = new Map();
  }

  config() {
    if (this.configProvider) return configFor(this.configProvider);
    if (this.initialConfig) return syncConfig(this.initialConfig);
    return syncConfig(loadConfig());
  }

  assertConfigured() {
    if (!this.config().serverUrl) throw syncError("Configure a sync server before enrolling conversations.", "sync_not_configured");
  }

  assertConfigurationChangeAllowed(previous, next) {
    if (previous?.serverUrl !== next?.serverUrl && this.active?.size) {
      throw syncError("Finish the active synchronized operation before changing the sync server.", "sync_active");
    }
  }

  async sessionMeta(sessionId) {
    if (!this.supervisor?.meta) return null;
    const meta = await this.supervisor.meta(sessionId);
    if (!meta) throw syncError("No such session.", "no_such_session", { status: 404 });
    return meta;
  }

  async assertIdle(sessionId) {
    if (this.supervisor?.isStreaming?.(sessionId)) throw syncError("Stop the current response before synchronizing this conversation.", "session_streaming");
    if (this.supervisor?.isCompacting?.(sessionId)) throw syncError("Wait for compaction to finish before synchronizing this conversation.", "session_compacting");
  }

  async beginMutation(sessionId, options = {}) {
    if (!this.config().serverUrl) return { managed: false };
    return this.prepareMutation(sessionId, { ...options, optional: true });
  }

  async withMutation(sessionId, task, options = {}) {
    const report = options.progress;
    report?.({ type: "phase", phase: "mutation-queued", message: "Waiting for other session mutations." });
    const previous = this.mutationQueues.get(sessionId) || Promise.resolve();
    let releaseQueue;
    const current = new Promise(resolve => { releaseQueue = resolve; });
    this.mutationQueues.set(sessionId, current);
    await previous;
    try {
      report?.({ type: "phase", phase: "mutation-start", message: "Starting session mutation." });
      const lease = await this.beginMutation(sessionId, options);
      report?.({ type: lease?.managed ? "phase" : "result", phase: lease?.managed ? "sync-ready" : "local-session", message: lease?.managed ? "Synchronization lease is ready." : "Session is local-only; no sync lease required." });
      let result;
      try {
        result = await task(lease);
      } catch (error) {
        if (lease?.managed) await this.release(sessionId, lease).catch(() => undefined);
        throw error;
      }
      // A failed settlement retains the uncertain lease and pending envelope
      // so a later heartbeat can retry safely. Do not release it from this
      // catch path; only task failures are safe to abandon without uploading.
      if (lease?.managed && !options.streaming) {
        report?.({ type: "phase", phase: "sync-settle", message: "Settling synchronized session state." });
        await this.commitAndRelease(sessionId, { ...lease, progress: report });
        report?.({ type: "result", phase: "sync-release", message: "Synchronization lease released." });
      }
      return result;
    } finally {
      releaseQueue();
      if (this.mutationQueues.get(sessionId) === current) this.mutationQueues.delete(sessionId);
    }
  }

  async prepareMutation() { return { managed: false }; }
  async commitSettled() { return { managed: false }; }
  async commitAndRelease() { return { managed: false }; }
  async release() { return { ok: true }; }
  async agentSettled() { return { ok: true }; }
  async sessionCreated() {}
  async reconcile() {}

}

/**
 * In-memory coordinator used by mock mode and unit tests. It intentionally
 * follows the same lifecycle as the network coordinator, including the
 * managed/no-op distinction for unenrolled local sessions.
 */
export class FakeSyncCoordinator extends BaseCoordinator {
  constructor(options = {}) {
    super(options);
    this.remote = new Map();
    this.leases = new Map();
    this.active = new Map();
  }

  state() {
    const config = this.config();
    return {
      version: SYNC_CAPABILITY_VERSION,
      configured: !!config.serverUrl,
      enabled: !!config.serverUrl,
      serverUrl: config.serverUrl,
      allConversations: config.allConversations,
      connection: config.serverUrl ? "available" : "disabled",
      implementation: "fake",
      error: null,
    };
  }

  status(sessionId) {
    const config = this.config();
    if (!config.serverUrl) return statusFor(config, false);
    const enrolled = this.remote.has(sessionId) || isSyncEnrolled(sessionId);
    const leaseHolder = this.leases.get(sessionId) || null;
    return statusFor(config, enrolled, {
      syncState: leaseHolder ? "in_use" : enrolled ? "available" : "pending",
      leaseHolder,
    });
  }

  async enroll(sessionId, { progress = null } = {}) {
    this.assertConfigured();
    progress?.({ type: "phase", phase: "sync-enroll-check", message: "Checking the local session before enrollment." });
    await this.assertIdle(sessionId);
    const meta = await this.sessionMeta(sessionId);
    progress?.({ type: "phase", phase: "sync-enroll-read", message: "Reading the local session transcript." });
    const records = this.supervisor?.transcript ? await this.supervisor.transcript(sessionId) : [];
    const existing = this.remote.get(sessionId);
    if (!existing) {
      this.remote.set(sessionId, {
        sessionId,
        envelope: { sessionId, formatVersion: 1, piSessionVersion: 1, createdAt: new Date().toISOString(), parentSessionId: null, headEntryId: records.at(-1)?.id || "", title: meta.name || "", entries: [], cwd: meta.cwd || null, records },
        etag: `fake-${this.remote.size + 1}`,
      });
    }
    progress?.({ type: "result", phase: "sync-enroll-write", message: existing ? "The synchronized session already exists." : "Writing the synchronized session snapshot." });
    markSyncEnrolled(sessionId);
    return { ok: true, created: !existing, ...(this.status(sessionId)) };
  }

  async prepareMutation(sessionId, { optional = false, allowStreaming = false } = {}) {
    this.assertConfigured();
    const existing = this.active.get(sessionId);
    if (existing) {
      if (!allowStreaming) await this.assertIdle(sessionId);
      return { managed: true, ...existing };
    }
    const current = this.status(sessionId);
    if (!current.synchronized) {
      if (this.config().allConversations) {
        await this.enroll(sessionId);
      } else if (optional) {
        return { managed: false };
      } else {
        throw syncError("Synchronize this conversation before mutating it.", "sync_not_enrolled");
      }
    }
    if (!allowStreaming) await this.assertIdle(sessionId);
    const remote = this.remote.get(sessionId);
    if (!remote) throw syncError("The synchronized conversation is unavailable.", "sync_session_not_found");
    const token = `fake-lease-${sessionId}`;
    this.leases.set(sessionId, "web");
    const active = { managed: true, token, etag: remote.etag, envelope: remote.envelope };
    this.active.set(sessionId, active);
    return { ...active, ...this.status(sessionId) };
  }

  async commitSettled(sessionId, { etag, envelope } = {}) {
    this.assertConfigured();
    const active = this.active.get(sessionId);
    if (!active) return { managed: false };
    const remote = this.remote.get(sessionId);
    if (!remote) throw syncError("The synchronized conversation is unavailable.", "sync_session_not_found");
    if (etag !== undefined && remote.etag !== etag) throw syncError("The synchronized conversation changed elsewhere.", "sync_stale_etag");
    const next = `fake-${Date.now().toString(36)}`;
    this.remote.set(sessionId, { sessionId, envelope: envelope || remote.envelope, etag: next });
    active.etag = next;
    return { ok: true, etag: next, ...this.status(sessionId) };
  }

  async commitAndRelease(sessionId, options = {}) {
    try { return await this.commitSettled(sessionId, options); }
    finally { await this.release(sessionId, options); }
  }

  async agentSettled(sessionId) {
    const active = this.active.get(sessionId);
    if (!active) return { ok: true };
    const records = this.supervisor?.transcript ? await this.supervisor.transcript(sessionId) : active.envelope;
    return this.commitAndRelease(sessionId, { token: active.token, etag: active.etag, envelope: records });
  }

  async sessionCreated(sessionId) {
    if (!this.config().allConversations) return;
    try { await this.enroll(sessionId); }
    catch { markSyncPending(sessionId); }
  }

  async reconcile() {
    if (!this.config().allConversations) return;
    try {
      for (const session of await this.supervisor?.allSessions?.() || []) {
        if (this.remote.has(session.id)) continue;
        try { await this.enroll(session.id); }
        catch { markSyncPending(session.id); }
      }
    } catch {
      // Mock reconciliation is best effort, matching the real coordinator's
      // startup behavior when session discovery is temporarily unavailable.
    }
  }

  async release(sessionId) {
    this.active.delete(sessionId);
    this.leases.delete(sessionId);
    return { ok: true, ...this.status(sessionId) };
  }

  setLeaseHolder(sessionId, holder = null) {
    if (holder) this.leases.set(sessionId, holder);
    else this.leases.delete(sessionId);
  }
}

export class PiSyncCoordinator extends BaseCoordinator {
  constructor({ supervisor, config = null, configProvider = null, clientFactory = null, adapter = null, heartbeatMs = HEARTBEAT_MS, holder = null } = {}) {
    super({ supervisor, config, configProvider });
    this.adapter = adapter;
    this.clientFactory = clientFactory || ((url) => createSyncClient(url, { timeoutMs: REQUEST_TIMEOUT_MS }));
    this.heartbeatMs = heartbeatMs;
    this.holder = holder || defaultHolder();
    this.clients = new Map();
    this.active = new Map();
    this.blocked = new Map();
    this.locks = new Map();
    this.listCache = null;
    this.listPromise = null;
    this.connection = "unavailable";
    this.lastError = null;
    this.reconcilePromise = null;
    if (this.config().serverUrl) queueMicrotask(() => { void this._health().catch(() => undefined); });
    if (this.config().allConversations) queueMicrotask(() => { void this.reconcile(); });
  }

  state() {
    const config = this.config();
    return {
      version: SYNC_CAPABILITY_VERSION,
      configured: !!config.serverUrl,
      enabled: !!config.serverUrl,
      serverUrl: config.serverUrl,
      allConversations: config.allConversations,
      connection: config.serverUrl ? this.connection : "disabled",
      implementation: config.serverUrl ? "client" : "unavailable",
      error: config.serverUrl ? this.lastError : null,
    };
  }

  async _client() {
    const url = this.config().serverUrl;
    this.assertConfigured();
    if (!this.clients.has(url)) {
      const pending = Promise.resolve()
        .then(() => this.clientFactory(url))
        .catch(error => { throw this._fromClientError(error, "sync_client_unavailable"); });
      this.clients.set(url, pending);
    }
    try {
      const client = await this.clients.get(url);
      return client;
    } catch (error) {
      this.clients.delete(url);
      this._recordConnection(error);
      throw error;
    }
  }

  _recordConnection(error = null) {
    if (!error) {
      this.connection = "available";
      this.lastError = null;
      return;
    }
    this.connection = "unavailable";
    this.lastError = { code: error.code || "sync_unavailable", message: safeMessage(error, "The synchronization service is unavailable.") };
  }

  _fromClientError(error, fallbackCode = "sync_unavailable") {
    if (error?.code === "sync_client_unavailable") return error;
    const code = clientErrorCode(error);
    const rawDetails = error?.details && typeof error.details === "object" ? error.details : undefined;
    const details = code === "active_lease" && rawDetails
      ? Object.fromEntries(["holder", "expiresAt"].filter(key => typeof rawDetails[key] === "string").map(key => [key, rawDetails[key]]))
      : undefined;
    if (code === "active_lease") return syncError(safeMessage(error, "The synchronized conversation is in use by another client."), "active_lease", { details });
    if (code === "stale_etag") return syncError(safeMessage(error, "The synchronized conversation changed elsewhere."), "sync_stale_etag", { details });
    if (code === "session_not_found") return syncError(safeMessage(error, "The synchronized conversation no longer exists on the sync server."), "sync_session_not_found", { details });
    if (isLeaseFailure(error)) return syncError("The synchronized lease expired or is no longer valid.", "sync_lease_uncertain", { details });
    if (isTransportError(error)) return syncError("The synchronization service could not be reached.", "sync_unavailable", { details });
    if (["duplicate_enrollment", "invalid_session", "request_too_large"].includes(code)) {
      return syncError(safeMessage(error, "The conversation could not be enrolled."), "sync_enrollment_failed", { details });
    }
    return syncError(safeMessage(error, "The synchronization service is unavailable."), fallbackCode, { details });
  }

  async _health() {
    try {
      const client = await this._client();
      const result = await client.health({ timeoutMs: 5_000 });
      this._recordConnection();
      return result;
    } catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
      this._recordConnection(converted);
      throw converted;
    }
  }

  async _list(force = false) {
    const now = Date.now();
    if (!force && this.listCache && now - this.listCache.at < STATUS_CACHE_MS) return this.listCache.sessions;
    if (!force && this.listPromise) return this.listPromise;
    this.listPromise = (async () => {
      try {
        const client = await this._client();
        const response = await client.list();
        this.listCache = { at: Date.now(), sessions: response.sessions || [] };
        this._recordConnection();
        return this.listCache.sessions;
      } catch (error) {
        const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
        this._recordConnection(converted);
        throw converted;
      } finally {
        this.listPromise = null;
      }
    })();
    return this.listPromise;
  }

  async status(sessionId) {
    const config = this.config();
    if (!config.serverUrl) return statusFor(config, false);
    const active = this.active.get(sessionId);
    const previousBlock = this.blocked.get(sessionId);
    if (!active && previousBlock) {
      return statusFor(config, true, { syncState: "error", leaseHolder: null, syncError: previousBlock });
    }
    if (active) {
      return statusFor(config, true, {
        syncState: active.blocked ? "error" : "in_use",
        leaseHolder: active.holder,
        leaseExpiresAt: active.expiresAt || null,
        ...(active.blocked ? { syncError: active.blocked } : {}),
      });
    }
    const locallyEnrolled = isSyncEnrolled(sessionId);
    try {
      const remote = (await this._list()).find(item => item.sessionId === sessionId);
      if (!remote) {
        return statusFor(config, false, locallyEnrolled ? {
          syncState: "error",
          syncError: { code: "sync_session_not_found", message: "The sync server no longer has this conversation." },
        } : {});
      }
      const holder = remote.leaseHolder || null;
      return statusFor(config, true, {
        syncState: holder ? "in_use" : "available",
        leaseHolder: holder,
        leaseExpiresAt: remote.leaseExpiresAt || null,
      });
    } catch (error) {
      return statusFor(config, locallyEnrolled, {
        syncState: "error",
        syncError: { code: error.code || "sync_unavailable", message: safeMessage(error, "The synchronization service is unavailable.") },
      });
    }
  }

  async _exclusive(sessionId, task) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.locks.set(sessionId, current);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }

  async _sessionEnvelope(sessionId, { fallbackWorkspace = undefined } = {}) {
    const info = await this.supervisor?.syncSessionInfo?.(sessionId);
    if (!info?.file) throw syncError("No such session.", "no_such_session", { status: 404 });
    const parentResolver = async parentPath => {
      const parentId = this.supervisor?.sessionIdFromFile?.(parentPath);
      return isSessionId(parentId) ? parentId : null;
    };
    let workspace;
    try { workspace = await (this.adapter?.deriveWorkspacePointer || deriveWorkspacePointer)(info.cwd); }
    catch { workspace = undefined; }
    workspace ||= fallbackWorkspace;
    try {
      const envelope = await (this.adapter?.normalizeSessionFile || normalizeSessionFile)(info.file, {
        requestedSessionId: sessionId,
        headEntryId: info.headEntryId || "",
        title: info.title || "",
        ...(info.parentSessionId !== undefined ? { parentSessionId: info.parentSessionId } : {}),
        resolveParentSessionId: parentResolver,
        ...(workspace ? { workspace } : {}),
      });
      if (envelope.sessionId !== sessionId) throw new Error("native session ID does not match the requested session");
      return envelope;
    } catch (error) {
      if (error.code === "sync_client_unavailable") throw error;
      throw syncError(error.message || "The session could not be normalized.", "sync_enrollment_failed");
    }
  }

  async _enroll(sessionId, { automatic = false, progress = null } = {}) {
    this.assertConfigured();
    progress?.({ type: "phase", phase: "sync-enroll-check", message: "Checking the synchronization service." });
    await this.assertIdle(sessionId);
    const remote = (await this._list()).find(item => item.sessionId === sessionId);
    if (remote) {
      markSyncEnrolled(sessionId);
      this.blocked.delete(sessionId);
      return { ok: true, created: false, ...await this.status(sessionId) };
    }
    if (automatic && isSyncEnrolled(sessionId)) {
      markSyncPending(sessionId);
      throw syncError("The sync server no longer has this conversation; explicit re-enrollment is required.", "sync_session_not_found");
    }
    progress?.({ type: "phase", phase: "sync-enroll-read", message: "Normalizing the local session snapshot." });
    const envelope = await this._sessionEnvelope(sessionId);
    try {
      const client = await this._client();
      progress?.({ type: "phase", phase: "sync-enroll-write", message: "Uploading the enrollment snapshot." });
      const response = await client.enroll(envelope);
      markSyncEnrolled(sessionId);
      this.blocked.delete(sessionId);
      this.listCache = null;
      this._recordConnection();
      progress?.({ type: "result", phase: "sync-enroll-complete", message: "The remote enrollment was created." });
      return { ok: true, created: true, etag: response.etag, ...await this.status(sessionId) };
    } catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error, "sync_enrollment_failed");
      // A race with another client is safe: never overwrite its canonical copy.
      if (clientErrorCode(error) === "duplicate_enrollment") {
        this.listCache = null;
        throw syncError("This conversation is already synchronized elsewhere; the local copy was not overwritten.", "sync_duplicate");
      }
      throw converted;
    }
  }

  async enroll(sessionId, options = {}) {
    return this._exclusive(sessionId, () => this._enroll(sessionId, options));
  }

  async _ensureEnrolled(sessionId, optional) {
    const config = this.config();
    if (!config.allConversations && !isSyncEnrolled(sessionId)) {
      // Manual enrollment is opt-in. Do not turn a configured-but-unreachable
      // server into an outage for ordinary local conversations.
      if (optional) return false;
      const remote = (await this._list()).find(item => item.sessionId === sessionId);
      if (!remote) throw syncError("Synchronize this conversation before mutating it.", "sync_not_enrolled");
      markSyncEnrolled(sessionId);
    }
    if (config.allConversations && !isSyncEnrolled(sessionId)) await this._enroll(sessionId, { automatic: true });
    return true;
  }

  async _recoverActive(sessionId, active) {
    const client = active.client || await this._client();
    if (!["lease_invalid", "lease_not_found"].includes(active.leaseError)) {
      try {
        const renewed = await client.renew(sessionId, active.token, { timeoutMs: 5_000 });
        if (renewed.etag !== active.etag) {
          this._markBlocked(sessionId, active, "The canonical session changed elsewhere; the local session was preserved.", "sync_conflict");
          throw syncError("The canonical session changed elsewhere; the local session was preserved.", "sync_conflict");
        }
        if (active.pendingEnvelope) {
          const response = await client.update(sessionId, active.pendingEnvelope, active.token, active.etag);
          active.etag = response.etag;
          active.envelope = response.session;
          active.lastFingerprint = active.pendingFingerprint;
          active.pendingEnvelope = null;
          active.pendingFingerprint = null;
        }
        active.expiresAt = renewed.lease.expiresAt;
        active.uncertain = false;
        active.blocked = null;
        active.leaseError = null;
        this._startHeartbeat(sessionId, active);
        this._recordConnection();
        return active;
      } catch (error) {
        const rawCode = clientErrorCode(error);
        if (!["lease_invalid", "lease_not_found"].includes(rawCode)) {
          const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
          active.leaseError = rawCode;
          active.blocked = { code: "sync_lease_uncertain", message: "The synchronized lease is uncertain; wait for the service to recover." };
          throw converted.code === "sync_unavailable"
            ? syncError("The synchronized lease is uncertain; wait for the service to recover.", "sync_lease_uncertain")
            : converted;
        }
        active.leaseError = rawCode;
      }
    }
    let acquired;
    try { acquired = await client.acquire(sessionId, this.holder); }
    catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
      if (converted.code === "active_lease") {
        active.blocked = { code: "active_lease", message: converted.message, details: converted.details };
        throw converted;
      }
      throw converted.code === "sync_unavailable" ? syncError("The synchronized lease is uncertain; wait for the service to recover.", "sync_lease_uncertain") : converted;
    }
    const expectedEtag = active.etag;
    active.client = client;
    active.token = acquired.lease.token;
    active.etag = acquired.etag;
    active.expiresAt = acquired.lease.expiresAt;
    if (acquired.session?.sessionId !== sessionId) {
      active.blocked = { code: "sync_enrollment_failed", message: "The sync server returned a different session identity." };
      await this._releaseUnlocked(sessionId, active);
      throw syncError(active.blocked.message, active.blocked.code);
    }
    if (acquired.etag !== expectedEtag) {
      this._markBlocked(sessionId, active, "The canonical session changed elsewhere; the local session was preserved.", "sync_conflict");
      throw syncError("The canonical session changed elsewhere; the local session was preserved.", "sync_conflict");
    }
    if (active.pendingEnvelope) {
      try {
        const response = await client.update(sessionId, active.pendingEnvelope, active.token, active.etag);
        active.etag = response.etag;
        active.envelope = response.session;
        active.lastFingerprint = active.pendingFingerprint;
        active.pendingEnvelope = null;
        active.pendingFingerprint = null;
        active.uncertain = false;
        active.blocked = null;
        active.leaseError = null;
        this.active.set(sessionId, active);
        this._startHeartbeat(sessionId, active);
        this._recordConnection();
        return active;
      } catch (error) {
        const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
        if (converted.code === "sync_stale_etag") {
          this._markBlocked(sessionId, active, "The canonical session changed elsewhere; the local session was preserved.", "sync_conflict", converted.details);
        } else {
          active.uncertain = true;
          active.leaseError = clientErrorCode(error);
          active.blocked = { code: "sync_lease_uncertain", message: "The synchronized lease could not be settled yet." };
          this._recordConnection(converted);
          this._emit(sessionId);
        }
        throw converted.code === "sync_unavailable"
          ? syncError("The synchronized lease is uncertain; wait for the service to recover.", "sync_lease_uncertain")
          : converted;
      }
    }
    try {
      const info = await this.supervisor?.syncSessionInfo?.(sessionId);
      if (acquired.session?.workspace) verifyWorkspacePointer(acquired.session.workspace, info?.cwd);
      if (this.supervisor?.prepareSyncSnapshot) {
        await this.supervisor.prepareSyncSnapshot(sessionId, acquired.session, (file, envelope, options) =>
          (this.adapter?.materializeSessionFile || materializeSessionFile)(file, envelope, options));
      }
    } catch (error) {
      active.blocked = { code: error.code || "sync_materialization_failed", message: error.message || "The canonical session could not be materialized." };
      await this._releaseUnlocked(sessionId, active);
      if (error.code === "sync_workspace_setup_required") throw syncError(error.message, error.code);
      throw syncError(error.message || "The canonical session could not be materialized.", "sync_materialization_failed");
    }
    active.envelope = acquired.session;
    active.lastFingerprint = stableEnvelopeFingerprint(acquired.session);
    active.uncertain = false;
    active.blocked = null;
    active.leaseError = null;
    this.active.set(sessionId, active);
    this._startHeartbeat(sessionId, active);
    this._recordConnection();
    return active;
  }

  async prepareMutation(sessionId, { optional = false, allowStreaming = false, progress = null } = {}) {
    this.assertConfigured();
    progress?.({ type: "phase", phase: "sync-prepare", message: "Checking synchronization state." });
    return this._exclusive(sessionId, async () => {
      let current = this.active.get(sessionId);
      if (current?.releasePending) {
        await this._releaseUnlocked(sessionId, current);
        if (this.active.get(sessionId) === current) {
          throw syncError("The synchronized lease cleanup is still pending; retry shortly.", "sync_unavailable");
        }
        current = null;
      }
      if (current) {
        if (current.blocked?.code === "sync_lease_uncertain" && !allowStreaming) return { managed: true, ...await this._recoverActive(sessionId, current) };
        if (current.blocked) throw syncError(current.blocked.message, current.blocked.code, { details: current.blocked.details });
        if (current.uncertain) {
          if (allowStreaming) throw syncError("The synchronized lease is uncertain; wait for it to be verified before continuing.", "sync_lease_uncertain");
          return { managed: true, ...await this._recoverActive(sessionId, current) };
        }
        if (!allowStreaming) await this.assertIdle(sessionId);
        return { managed: true, ...current };
      }
      const previousBlock = this.blocked.get(sessionId);
      if (previousBlock) throw syncError(previousBlock.message, previousBlock.code, { details: previousBlock.details });
      const enrolled = await this._ensureEnrolled(sessionId, optional);
      if (!enrolled) return { managed: false };
      if (!allowStreaming) await this.assertIdle(sessionId);
      progress?.({ type: "phase", phase: "sync-acquire", message: "Acquiring synchronization lease." });
      const client = await this._client();
      let acquired;
      try { acquired = await client.acquire(sessionId, this.holder); }
      catch (error) {
        const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
        throw converted;
      }
      const active = {
        managed: true,
        token: acquired.lease.token,
        etag: acquired.etag,
        holder: acquired.lease.holder || this.holder,
        expiresAt: acquired.lease.expiresAt,
        client,
        envelope: acquired.session,
        preparing: true,
        uncertain: false,
        blocked: null,
        pendingEnvelope: null,
        lastFingerprint: stableEnvelopeFingerprint(acquired.session),
        renewing: false,
      };
      this.active.set(sessionId, active);
      try {
        if (acquired.session?.sessionId !== sessionId) {
          throw syncError("The sync server returned a different session identity.", "sync_enrollment_failed");
        }
        progress?.({ type: "phase", phase: "sync-materialize", message: "Materializing the canonical session snapshot." });
        const info = await this.supervisor?.syncSessionInfo?.(sessionId);
        if (acquired.session.workspace) verifyWorkspacePointer(acquired.session.workspace, info?.cwd);
        if (this.supervisor?.prepareSyncSnapshot) {
          await this.supervisor.prepareSyncSnapshot(sessionId, acquired.session, (file, envelope, options) =>
            (this.adapter?.materializeSessionFile || materializeSessionFile)(file, envelope, options));
        }
      } catch (error) {
        active.blocked = { code: error.code || "sync_materialization_failed", message: error.message || "The canonical session could not be materialized." };
        await this._releaseUnlocked(sessionId, active);
        if (error.code === "session_streaming" || error.code === "session_compacting") throw error;
        if (error.code === "sync_workspace_setup_required") throw syncError(error.message, error.code);
        throw syncError(error.message || "The canonical session could not be materialized.", error.code === "sync_enrollment_failed" ? error.code : "sync_materialization_failed");
      }
      active.preparing = false;
      this.blocked.delete(sessionId);
      this._startHeartbeat(sessionId, active);
      this._emit(sessionId);
      return { ...active };
    });
  }

  _startHeartbeat(sessionId, active) {
    if (active.timer) clearInterval(active.timer);
    active.timer = setInterval(() => {
      void this._exclusive(sessionId, () => this._heartbeat(sessionId, active)).catch(error => {
        if (this.active.get(sessionId) !== active) return;
        active.uncertain = true;
        active.leaseError = clientErrorCode(error);
        active.blocked = { code: "sync_lease_uncertain", message: "The synchronized lease could not be renewed." };
        this._recordConnection(error);
        this._emit(sessionId);
      });
    }, this.heartbeatMs);
    active.timer.unref?.();
  }

  async _heartbeat(sessionId, active) {
    if (this.active.get(sessionId) !== active || active.renewing) return;
    active.renewing = true;
    try {
      if (active.releasePending) {
        try {
          await active.client.release(sessionId, active.token);
          this._forgetActive(sessionId, active);
          this._recordConnection();
          this._emit(sessionId);
          return;
        } catch (error) {
          const code = clientErrorCode(error);
          if (["lease_invalid", "lease_not_found"].includes(code)) {
            this._forgetActive(sessionId, active);
            this._recordConnection();
            this._emit(sessionId);
            return;
          }
          this._recordConnection(error);
        }
      }
      const response = await active.client.renew(sessionId, active.token, { timeoutMs: 5_000 });
      if (response.etag !== active.etag) {
        this._markBlocked(sessionId, active, "The canonical session changed while this lease was uncertain.", "sync_conflict");
        return;
      }
      active.expiresAt = response.lease.expiresAt;
      active.uncertain = false;
      if (active.blocked?.code === "sync_lease_uncertain") active.blocked = null;
      if (active.pendingEnvelope) await this._flushPending(sessionId, active);
      this._emit(sessionId);
    } catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
      if (isMissingSession(converted)) {
        this._markBlocked(sessionId, active, "The sync server no longer has this conversation.", "sync_session_not_found");
      } else {
        active.uncertain = true;
        active.leaseError = clientErrorCode(error);
        active.blocked = { code: "sync_lease_uncertain", message: "The synchronized lease could not be renewed." };
        this._recordConnection(converted);
        this._emit(sessionId);
      }
    } finally {
      active.renewing = false;
    }
  }

  _markBlocked(sessionId, active, message, code, details) {
    active.uncertain = true;
    active.blocked = { code, message, details };
    this.blocked.set(sessionId, active.blocked);
    this._emit(sessionId);
    if (code !== "sync_lease_uncertain") {
      void this._exclusive(sessionId, async () => {
        if (this.active.get(sessionId) === active) await this._releaseUnlocked(sessionId, active);
        this._emit(sessionId);
      });
    }
  }

  async _normalizeForCommit(sessionId, active) {
    const envelope = await this._sessionEnvelope(sessionId, { fallbackWorkspace: active.envelope?.workspace });
    active.pendingEnvelope = envelope;
    active.pendingFingerprint = stableEnvelopeFingerprint(envelope);
    return envelope;
  }

  async _flushPending(sessionId, active) {
    if (this.active.get(sessionId) !== active || !active.pendingEnvelope || active.uncertain || active.blocked) return;
    try {
      const response = await active.client.update(sessionId, active.pendingEnvelope, active.token, active.etag);
      active.etag = response.etag;
      active.envelope = response.session;
      active.lastFingerprint = active.pendingFingerprint;
      active.pendingEnvelope = null;
      active.pendingFingerprint = null;
      await this._releaseUnlocked(sessionId, active);
      this._recordConnection();
      this._emit(sessionId);
    } catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
      if (converted.code === "sync_stale_etag") this._markBlocked(sessionId, active, "The canonical session changed elsewhere; the local session was preserved.", "sync_conflict", converted.details);
      else if (isMissingSession(converted)) this._markBlocked(sessionId, active, "The sync server no longer has this conversation.", "sync_session_not_found");
      else {
        active.uncertain = true;
        active.blocked = { code: "sync_lease_uncertain", message: "The settled session could not be uploaded yet." };
        this._recordConnection(converted);
        this._emit(sessionId);
      }
    }
  }

  async _commitUnlocked(sessionId, active, progress = null) {
    if (this.active.get(sessionId) !== active) return { managed: false };
    let envelope;
    try {
      progress?.({ type: "phase", phase: "sync-normalize", message: "Normalizing the updated session snapshot." });
      envelope = await this._normalizeForCommit(sessionId, active);
    } catch (error) {
      const converted = error?.code?.startsWith?.("sync_")
        ? error
        : syncError(error?.message || "The settled session could not be normalized.", "sync_materialization_failed");
      this._markBlocked(sessionId, active, converted.message, converted.code, converted.details);
      throw converted;
    }
    if (active.uncertain || active.blocked) throw syncError(active.blocked?.message || "The synchronized lease is uncertain.", active.blocked?.code || "sync_lease_uncertain", { details: active.blocked?.details });
    if (active.lastFingerprint === active.pendingFingerprint) {
      await this._releaseUnlocked(sessionId, active);
      return { ok: true, etag: active.etag, ...await this.status(sessionId) };
    }
    try {
      progress?.({ type: "phase", phase: "sync-upload", message: "Uploading the settled session snapshot." });
      const response = await active.client.update(sessionId, envelope, active.token, active.etag);
      active.etag = response.etag;
      active.envelope = response.session;
      active.lastFingerprint = active.pendingFingerprint;
      active.pendingEnvelope = null;
      active.pendingFingerprint = null;
      this._recordConnection();
      await this._releaseUnlocked(sessionId, active);
      this._emit(sessionId);
      return { ok: true, etag: response.etag, ...await this.status(sessionId) };
    } catch (error) {
      const converted = error.code?.startsWith("sync_") ? error : this._fromClientError(error);
      if (converted.code === "sync_stale_etag") this._markBlocked(sessionId, active, "The canonical session changed elsewhere; the local session was preserved.", "sync_conflict", converted.details);
      else if (isMissingSession(converted)) this._markBlocked(sessionId, active, "The sync server no longer has this conversation.", "sync_session_not_found");
      else {
        active.uncertain = true;
        active.blocked = { code: "sync_lease_uncertain", message: "The settled session could not be uploaded yet." };
        this._recordConnection(converted);
        this._emit(sessionId);
      }
      throw converted;
    }
  }

  async commitSettled(sessionId, options = {}) {
    return this._exclusive(sessionId, async () => {
      const active = this.active.get(sessionId);
      if (!active) return { managed: false };
      return this._commitUnlocked(sessionId, active, options.progress);
    });
  }

  async commitAndRelease(sessionId, options = {}) {
    return this.commitSettled(sessionId, options);
  }

  async agentSettled(sessionId) {
    return this.commitSettled(sessionId);
  }

  _forgetActive(sessionId, active) {
    if (active.timer) clearInterval(active.timer);
    active.timer = null;
    active.releasePending = false;
    if (this.active.get(sessionId) === active) this.active.delete(sessionId);
    this.listCache = null;
  }

  async _releaseUnlocked(sessionId, active) {
    if (this.active.get(sessionId) !== active) return;
    if (active.releasing) return active.releasing;
    if (active.timer) clearInterval(active.timer);
    active.timer = null;
    active.releasing = (async () => {
      try {
        await active.client.release(sessionId, active.token);
        this._forgetActive(sessionId, active);
      } catch (error) {
        const code = clientErrorCode(error);
        if (["lease_invalid", "lease_not_found"].includes(code)) {
          this._forgetActive(sessionId, active);
          return;
        }
        // Keep the in-memory lease when cleanup is interrupted. The heartbeat
        // retries release so this web process does not strand itself behind
        // its own server-side lease for the full expiry window.
        active.releasePending = true;
        this._recordConnection(error);
        this._startHeartbeat(sessionId, active);
      } finally {
        active.releasing = null;
      }
    })();
    return active.releasing;
  }

  async release(sessionId) {
    return this._exclusive(sessionId, async () => {
      const active = this.active.get(sessionId);
      if (active) await this._releaseUnlocked(sessionId, active);
      this._emit(sessionId);
      return { ok: true, ...await this.status(sessionId) };
    });
  }

  async skillPaths() {
    try {
      if (!this.config().serverUrl) return [];
      const skillPath = await syncSkillPath();
      return skillPath ? [skillPath] : [];
    } catch {
      return [];
    }
  }

  async contextForSession(sessionId) {
    const active = this.active.get(sessionId);
    const workspace = active?.envelope?.workspace || active?.pendingEnvelope?.workspace;
    if (!workspace) return null;
    return `Synchronized workspace: upstream branch ${workspace.branch} at pushed commit ${workspace.commit}. Follow the synchronized-workspace skill before handing work to another runtime.`;
  }

  async sessionCreated(sessionId) {
    if (this.config().allConversations) void this.reconcileSession(sessionId);
  }

  async reconcileSession(sessionId) {
    if (!this.config().allConversations) return;
    try {
      await this._exclusive(sessionId, async () => {
        await this._enroll(sessionId, { automatic: true });
      });
      this._emit(sessionId);
    } catch (error) {
      if (["session_streaming", "session_compacting", "sync_unavailable", "sync_client_unavailable", "sync_session_not_found", "sync_enrollment_failed"].includes(error.code)) markSyncPending(sessionId);
      this._emit(sessionId);
    }
  }

  async reconcile() {
    if (!this.config().allConversations || this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      try {
        const sessions = await this.supervisor?.allSessions?.() || [];
        for (const session of sessions) await this.reconcileSession(session.id);
      } catch (error) {
        const converted = error?.code?.startsWith?.("sync_") ? error : this._fromClientError(error, "sync_unavailable");
        this._recordConnection(converted);
      } finally {
        this.reconcilePromise = null;
      }
    })();
    return this.reconcilePromise;
  }

  _emit(sessionId) {
    const hub = this.supervisor?.hub;
    if (!hub?.emit) return;
    void this.status(sessionId).then(sync => hub.emit(sessionId, "sync_state", { sync })).catch(() => undefined);
  }
}

function defaultHolder() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
  return `pi-web-${host}`;
}

export function createSyncCoordinator({ supervisor, config = null, configProvider = null, ...options } = {}) {
  const explicitFake = process.env.PI_WEB_SYNC_MODE === "fake";
  const mockFake = process.env.PI_WEB_MODE === "mock" && process.env.PI_WEB_SYNC_MODE !== "unavailable";
  if (explicitFake || mockFake) return new FakeSyncCoordinator({ supervisor, config, configProvider });
  return new PiSyncCoordinator({ supervisor, config, configProvider, ...options });
}
