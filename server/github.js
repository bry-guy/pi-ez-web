import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appHome, githubConfig, loadConfig } from "./config.js";

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const FLOW_TTL_MS = 15 * 60 * 1000;
const TERMINAL_TTL_MS = 60 * 1000;

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function safeText(value, max = 300) {
  return String(value ?? "").slice(0, max);
}

function safeJson(response) {
  return response.json().catch(() => ({}));
}

function authPath() {
  return path.join(appHome(), "github-auth.json");
}

function atomicWrite(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, mode); } catch { /* permissions are best effort on non-POSIX filesystems */ }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readStoredAuth() {
  try {
    const value = JSON.parse(fs.readFileSync(authPath(), "utf8"));
    return typeof value?.accessToken === "string" && value.accessToken ? value : null;
  } catch {
    return null;
  }
}

function redactedUpstreamMessage(body) {
  const raw = typeof body === "string" ? body : body?.message || body?.error_description || "GitHub request failed";
  return safeText(raw)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}

function mapGithubFailure(response, body) {
  if (response.status === 401) return coded("github_auth_required");
  if (response.status === 403) return coded("github_rate_limited", "GitHub denied the request or requires organization SSO authorization.");
  if (response.status === 404) return coded("github_not_found");
  const error = coded("github_unavailable", "GitHub is temporarily unavailable.");
  error.detail = redactedUpstreamMessage(body);
  return error;
}

function validateFullName(fullName) {
  const value = String(fullName || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw coded("invalid_github_repository");
  return value;
}

function normalizeGitHubOwner(owner) {
  const value = String(owner ?? "").trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) {
    throw coded("invalid_github_owner", "Enter a valid GitHub user or organization name.");
  }
  return value;
}

export class GitHubClient {
  constructor({ fetchImpl = globalThis.fetch, authFile = null, configOverride = null } = {}) {
    this.fetch = fetchImpl;
    this.authFile = authFile;
    this.configOverride = configOverride;
  }

  config() { return this.configOverride || githubConfig(loadConfig()); }

  authFilePath() { return this.authFile || authPath(); }

  storedAuth() {
    try {
      const value = JSON.parse(fs.readFileSync(this.authFilePath(), "utf8"));
      return typeof value?.accessToken === "string" && value.accessToken ? value : null;
    } catch {
      return null;
    }
  }

  effectiveAuth() {
    const environmentToken = process.env.PI_WEB_GITHUB_TOKEN;
    if (environmentToken) return { accessToken: environmentToken, source: "environment", account: null };
    const stored = this.storedAuth();
    return stored ? { ...stored, source: "stored" } : null;
  }

  status() {
    const cfg = this.config();
    const auth = this.effectiveAuth();
    return {
      configured: !!cfg.clientId,
      authenticated: !!auth,
      credentialSource: auth?.source || null,
      account: auth?.account || null,
      owner: cfg.owner || null,
    };
  }

  saveToken({ accessToken, tokenType = "bearer", scope = "", account = null }) {
    if (!accessToken) throw coded("github_token_missing");
    atomicWrite(this.authFilePath(), { version: 1, accessToken, tokenType, scope, account });
  }

  logout() {
    if (process.env.PI_WEB_GITHUB_TOKEN) throw coded("credential_managed_by_environment");
    try { fs.rmSync(this.authFilePath(), { force: true }); } catch (error) {
      throw Object.assign(new Error("github_logout_failed"), { code: "github_logout_failed", cause: error });
    }
  }

  async request(endpoint, { token, ...init } = {}) {
    const auth = token ? { accessToken: token } : this.effectiveAuth();
    if (!auth?.accessToken) throw coded("github_auth_required");
    const url = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;
    const response = await this.fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "pi-ez-web",
        authorization: `Bearer ${auth.accessToken}`,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw mapGithubFailure(response, await safeJson(response));
    return response;
  }

  async publicRequest(endpoint, init = {}) {
    const url = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;
    const response = await this.fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "pi-ez-web",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw mapGithubFailure(response, await safeJson(response));
    return response;
  }

  async accountForToken(accessToken) {
    const response = await this.request("/user", { token: accessToken });
    const user = await safeJson(response);
    return {
      id: Number.isSafeInteger(user.id) ? user.id : null,
      login: typeof user.login === "string" ? user.login : null,
    };
  }

  mapRepository(repo) {
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login || null,
      private: !!repo.private,
      updatedAt: repo.updated_at || null,
    };
  }

  async listRepositories({ query = "", page = 1 } = {}) {
    const cfg = this.config();
    const params = new URLSearchParams({
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      per_page: "100",
      page: String(Math.max(1, Number(page) || 1)),
      sort: "updated",
      direction: "desc",
    });
    const response = await this.request(`/user/repos?${params}`);
    const values = await safeJson(response);
    const q = String(query || "").trim().toLowerCase();
    const repos = (Array.isArray(values) ? values : []).filter(repo => {
      const owner = repo.owner?.login || "";
      const fullName = repo.full_name || "";
      const matchesOwner = !cfg.owner || owner.toLowerCase() === cfg.owner.toLowerCase();
      const matchesQuery = !q || repo.name?.toLowerCase().includes(q) || fullName.toLowerCase().includes(q);
      return matchesOwner && matchesQuery;
    }).map(repo => this.mapRepository(repo));
    const link = response.headers.get("link") || "";
    return { repos, nextPage: /<[^>]+>;\s*rel="next"/.test(link) ? Number(page) + 1 : null };
  }

  async listPublicRepositories({ owner, query = "", page = 1 } = {}) {
    const account = normalizeGitHubOwner(owner || this.config().owner);
    if (!account) throw coded("github_owner_required");
    const params = new URLSearchParams({
      type: "owner",
      per_page: "100",
      page: String(Math.max(1, Number(page) || 1)),
      sort: "updated",
      direction: "desc",
    });
    const response = await this.publicRequest(`/users/${encodeURIComponent(account)}/repos?${params}`);
    const values = await safeJson(response);
    const q = String(query || "").trim().toLowerCase();
    const repos = (Array.isArray(values) ? values : []).filter(repo => {
      const fullName = repo.full_name || "";
      return !q || repo.name?.toLowerCase().includes(q) || fullName.toLowerCase().includes(q);
    }).map(repo => this.mapRepository(repo));
    const link = response.headers.get("link") || "";
    return { repos, nextPage: /<[^>]+>;\s*rel="next"/.test(link) ? Number(page) + 1 : null };
  }

  async repository(fullName) {
    const value = validateFullName(fullName);
    const [owner, name] = value.split("/");
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const response = this.effectiveAuth()
      ? await this.request(endpoint)
      : await this.publicRequest(endpoint);
    const repo = await safeJson(response);
    if (repo.full_name !== value || typeof repo.clone_url !== "string") throw coded("github_not_found");
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login || owner,
      private: !!repo.private,
      cloneUrl: repo.clone_url,
    };
  }

  async startDeviceFlow() {
    const clientId = this.config().clientId;
    if (!clientId) throw coded("github_not_configured", "GitHub OAuth is not configured on this server.");
    const response = await this.fetch(DEVICE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: "repo read:user" }),
    });
    const body = await safeJson(response);
    if (!response.ok || !body.device_code || !body.user_code || !body.verification_uri) {
      const error = coded("github_login_unavailable", "GitHub login could not start.");
      error.detail = redactedUpstreamMessage(body);
      throw error;
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      intervalSeconds: Math.max(5, Number(body.interval) || 5),
      expiresInSeconds: Math.max(1, Number(body.expires_in) || 900),
    };
  }

  async pollDeviceFlow(deviceCode, signal) {
    const clientId = this.config().clientId;
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      signal,
    });
    const body = await safeJson(response);
    if (body.access_token) return { state: "complete", accessToken: body.access_token, tokenType: body.token_type, scope: body.scope };
    if (body.error === "authorization_pending") return { state: "pending" };
    if (body.error === "slow_down") return { state: "slow_down" };
    if (body.error === "expired_token") return { state: "error", code: "github_device_expired", message: "The GitHub device code expired." };
    if (body.error === "access_denied") return { state: "error", code: "github_access_denied", message: "GitHub denied the authorization request." };
    return { state: "error", code: "github_login_failed", message: "GitHub login did not complete.", detail: redactedUpstreamMessage(body) };
  }
}

export class GitHubDeviceFlowManager {
  constructor(client) {
    this.client = client;
    this.flows = new Map();
    this.activeId = null;
  }

  view(flow) {
    return {
      id: flow.id,
      state: flow.state,
      ...(flow.userCode ? { userCode: flow.userCode } : {}),
      ...(flow.verificationUri ? { verificationUri: flow.verificationUri } : {}),
      ...(flow.expiresAt ? { expiresAt: new Date(flow.expiresAt).toISOString() } : {}),
      ...(flow.intervalSeconds ? { intervalSeconds: flow.intervalSeconds } : {}),
      ...(flow.account ? { account: flow.account } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }

  async start() {
    if (this.activeId) throw coded("github_flow_active");
    const device = await this.client.startDeviceFlow();
    const flow = {
      id: `ghf_${randomUUID()}`,
      state: "waiting_user",
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresAt: Date.now() + device.expiresInSeconds * 1000,
      controller: new AbortController(),
      timer: null,
      account: null,
      error: null,
    };
    this.flows.set(flow.id, flow);
    this.activeId = flow.id;
    this.schedule(flow, 0);
    return flow;
  }

  schedule(flow, delay) {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => this.poll(flow), delay);
    flow.timer.unref?.();
  }

  async poll(flow) {
    if (!this.flows.has(flow.id) || flow.controller.signal.aborted) return;
    if (Date.now() >= flow.expiresAt) {
      this.finish(flow, "error", { code: "github_device_expired", message: "The GitHub device code expired." });
      return;
    }
    try {
      const result = await this.client.pollDeviceFlow(flow.deviceCode, flow.controller.signal);
      if (result.state === "pending" || result.state === "slow_down") {
        if (result.state === "slow_down") flow.intervalSeconds += 5;
        this.schedule(flow, flow.intervalSeconds * 1000);
        return;
      }
      if (result.state === "complete") {
        // Validate the token before persisting it. A token that cannot identify
        // the account must not make the UI claim that GitHub is connected.
        const account = await this.client.accountForToken(result.accessToken);
        this.client.saveToken({ accessToken: result.accessToken, tokenType: result.tokenType, scope: result.scope, account });
        flow.account = account;
        this.finish(flow, "complete");
        return;
      }
      this.finish(flow, "error", { code: result.code || "github_login_failed", message: result.message || "GitHub login did not complete." });
    } catch (error) {
      if (flow.controller.signal.aborted || error?.name === "AbortError") {
        this.finish(flow, "cancelled", { code: "github_login_cancelled", message: "GitHub login was cancelled." });
        return;
      }
      this.finish(flow, "error", { code: error.code || "github_login_failed", message: error.code === "github_auth_required" ? "GitHub authorization was rejected." : "GitHub login did not complete." });
      console.error("pi-ez-web GitHub device flow failed", { flowId: flow.id, code: error.code || "unknown", detail: redactedUpstreamMessage(error) });
    }
  }

  finish(flow, state, error = null) {
    clearTimeout(flow.timer);
    flow.state = state;
    flow.error = error;
    flow.deviceCode = null;
    if (this.activeId === flow.id) this.activeId = null;
    flow.timer = setTimeout(() => this.flows.delete(flow.id), TERMINAL_TTL_MS);
    flow.timer.unref?.();
  }

  get(id) {
    const flow = this.flows.get(id);
    if (!flow) throw coded("no_such_github_flow");
    return flow;
  }

  cancel(id) {
    const flow = this.get(id);
    if (["complete", "error", "cancelled"].includes(flow.state)) return;
    flow.controller.abort();
    this.finish(flow, "cancelled", { code: "github_login_cancelled", message: "GitHub login was cancelled." });
  }
}

export { authPath, atomicWrite, readStoredAuth, coded as githubError, normalizeGitHubOwner, validateFullName };
