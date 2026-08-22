import { loadConfig, syncConfig } from "../config.js";
import { isSyncEnrolled } from "./enrollment.js";

export const SYNC_CAPABILITY_VERSION = 1;

function syncError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function configFor(provider) {
  try { return syncConfig(provider?.()); } catch { return syncConfig(loadConfig()); }
}

function statusFor(config, sessionId, enrolled, extra = {}) {
  if (!config.serverUrl) return { synchronized: false, ...extra };
  return {
    synchronized: !!enrolled,
    syncState: enrolled ? "available" : "pending",
    leaseHolder: null,
    ...extra,
  };
}

class BaseCoordinator {
  constructor({ supervisor = null, config = null, configProvider = null } = {}) {
    this.supervisor = supervisor;
    this.initialConfig = config;
    this.configProvider = configProvider;
  }

  config() {
    if (this.configProvider) return configFor(this.configProvider);
    if (this.initialConfig) return syncConfig(this.initialConfig);
    return syncConfig(loadConfig());
  }

  assertConfigured() {
    if (!this.config().serverUrl) throw syncError("Configure a sync server before enrolling conversations.", "sync_not_configured");
  }

  async sessionMeta(sessionId) {
    if (!this.supervisor?.meta) return null;
    const meta = await this.supervisor.meta(sessionId);
    if (!meta) throw syncError("No such session.", "no_such_session");
    return meta;
  }

  async assertIdle(sessionId) {
    if (this.supervisor?.isStreaming?.(sessionId)) throw syncError("Stop the current response before synchronizing this conversation.", "session_streaming");
    if (this.supervisor?.isCompacting?.(sessionId)) throw syncError("Wait for compaction to finish before synchronizing this conversation.", "session_compacting");
  }

  disabledState() {
    const config = this.config();
    return {
      version: SYNC_CAPABILITY_VERSION,
      configured: !!config.serverUrl,
      enabled: !!config.serverUrl,
      serverUrl: config.serverUrl,
      allConversations: config.allConversations,
      connection: config.serverUrl ? "unavailable" : "disabled",
      implementation: "unavailable",
      error: config.serverUrl ? { code: "sync_client_unavailable", message: "The pi-sync client is not installed yet." } : null,
    };
  }

  async prepareMutation() { throw syncError("The pi-sync client is not installed yet.", "sync_client_unavailable"); }
  async commitSettled() { throw syncError("The pi-sync client is not installed yet.", "sync_client_unavailable"); }
  async commitAndRelease() { throw syncError("The pi-sync client is not installed yet.", "sync_client_unavailable"); }
  async release() { return { ok: true }; }
}

/**
 * Development/test adapter used until the standalone pi-sync package is
 * available. It deliberately keeps the same narrow coordinator boundary as
 * the eventual network implementation, so routes and the supervisor never
 * learn the syncd protocol.
 */
export class FakeSyncCoordinator extends BaseCoordinator {
  constructor(options = {}) {
    super(options);
    this.remote = new Map();
    this.leases = new Map();
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
    if (!config.serverUrl) return statusFor(config, sessionId, false);
    const enrolled = this.remote.has(sessionId) || isSyncEnrolled(sessionId);
    const leaseHolder = this.leases.get(sessionId) || null;
    return statusFor(config, sessionId, enrolled, {
      syncState: leaseHolder ? "in_use" : enrolled ? "available" : "pending",
      leaseHolder,
    });
  }

  async enroll(sessionId) {
    this.assertConfigured();
    await this.assertIdle(sessionId);
    const meta = await this.sessionMeta(sessionId);
    const records = this.supervisor?.transcript ? await this.supervisor.transcript(sessionId) : [];
    const existing = this.remote.get(sessionId);
    if (!existing) {
      this.remote.set(sessionId, {
        sessionId,
        envelope: { sessionId, cwd: meta.cwd || null, headEntryId: null, records },
        etag: `fake-${this.remote.size + 1}`,
      });
    }
    return { ok: true, created: !existing, ...(this.status(sessionId)) };
  }

  async prepareMutation(sessionId) {
    this.assertConfigured();
    const current = this.status(sessionId);
    if (!current.synchronized) throw syncError("Synchronize this conversation before mutating it.", "sync_not_enrolled");
    const token = `fake-lease-${sessionId}`;
    this.leases.set(sessionId, "web");
    return { ...current, token, etag: this.remote.get(sessionId)?.etag || null, envelope: this.remote.get(sessionId)?.envelope || null };
  }

  async commitSettled(sessionId, { token, etag, envelope } = {}) {
    this.assertConfigured();
    const current = this.status(sessionId);
    if (!current.synchronized) throw syncError("Synchronize this conversation before committing it.", "sync_not_enrolled");
    const expected = this.remote.get(sessionId)?.etag || null;
    if (etag !== undefined && expected && etag !== expected) throw syncError("The synchronized conversation changed elsewhere.", "sync_stale_etag", { status: 409 });
    const next = `fake-${Date.now().toString(36)}`;
    this.remote.set(sessionId, { sessionId, envelope: envelope || this.remote.get(sessionId)?.envelope || null, etag: next, token });
    return { ok: true, etag: next, ...(this.status(sessionId)) };
  }

  async commitAndRelease(sessionId, options = {}) {
    try { return await this.commitSettled(sessionId, options); }
    finally { await this.release(sessionId, options); }
  }

  async release(sessionId) {
    this.leases.delete(sessionId);
    return { ok: true, ...(this.status(sessionId)) };
  }

  // Test-only hook for exercising the browser's locked state before the real
  // lease protocol is wired in.
  setLeaseHolder(sessionId, holder = null) {
    if (holder) this.leases.set(sessionId, holder);
    else this.leases.delete(sessionId);
  }
}

export class UnavailableSyncCoordinator extends BaseCoordinator {
  state() { return this.disabledState(); }

  status(sessionId) {
    const config = this.config();
    if (!config.serverUrl) return statusFor(config, sessionId, false);
    return {
      synchronized: isSyncEnrolled(sessionId),
      syncState: "error",
      leaseHolder: null,
    };
  }

  async enroll() {
    this.assertConfigured();
    throw syncError("The pi-sync client is not installed yet.", "sync_client_unavailable");
  }
}

export function createSyncCoordinator({ supervisor, config = null, configProvider = null } = {}) {
  const configured = syncConfig(config || loadConfig());
  const explicitFake = process.env.PI_WEB_SYNC_MODE === "fake";
  const mockFake = process.env.PI_WEB_MODE === "mock" && process.env.PI_WEB_SYNC_MODE !== "unavailable";
  if (explicitFake || mockFake) return new FakeSyncCoordinator({ supervisor, config, configProvider });
  // Keep the production adapter fail-closed until the pinned pi-sync package
  // is present. A configured URL never changes local behavior silently.
  return new UnavailableSyncCoordinator({ supervisor, config, configProvider, configured });
}
