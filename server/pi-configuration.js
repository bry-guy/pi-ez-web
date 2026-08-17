// Pi configuration overlay for the web runtime.
//
// Pi "profiles" are normally just alternate PI_CODING_AGENT_DIR directories.
// pi-ez-web keeps credentials and sessions in its configured agent directory,
// but can layer the declarative settings.json from another directory or HTTPS
// URL over each SDK session. Packages from that profile are installed by Pi's
// normal DefaultResourceLoader into the persistent agent directory.
import fs from "node:fs";
import path from "node:path";
import { appHome, loadConfig, resolvePath } from "./config.js";

const MAX_PROFILE_BYTES = 512 * 1024;
const PROFILE_TIMEOUT_MS = 10_000;
const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"];
const DEFAULT_NPM_COMMAND = ["/usr/local/bin/npm", "--legacy-peer-deps", "--omit=dev"];

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mergeSettings(base, override) {
  const result = isObject(base) ? clone(base) : {};
  if (!isObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(result[key])) result[key] = mergeSettings(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function sourceOf(pkg) {
  return typeof pkg === "string" ? pkg : isObject(pkg) && typeof pkg.source === "string" ? pkg.source : null;
}

function isLocalSource(source) {
  return /^(?:\.{0,2}\/|~(?:\/|$)|\/)/.test(source) || /^[A-Za-z]:[\\/]/.test(source);
}

function resolveEntry(entry, baseDir, remote, warnings, kind) {
  const rawSource = sourceOf(entry);
  if (!rawSource) return null;
  const source = rawSource.trim();
  if (!source) return null;
  if (!isLocalSource(source)) return typeof entry === "string" ? source : { ...entry, source };
  if (remote) {
    warnings.push(`Ignored remote profile ${kind} path ${source}; remote profiles can reference npm/git sources, not files on the server.`);
    return null;
  }
  const resolved = path.resolve(baseDir, source.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  return typeof entry === "string" ? resolved : { ...entry, source: resolved };
}

function prepareProfileSettings(value, { baseDir, remote, warnings }) {
  const settings = clone(value);
  // Session and credential storage always remain owned by the deployment's
  // PI_CODING_AGENT_DIR, even when importing another profile's behavior.
  delete settings.sessionDir;

  if (Array.isArray(settings.packages)) {
    settings.packages = settings.packages
      .map(entry => resolveEntry(entry, baseDir, remote, warnings, "package"))
      .filter(Boolean);
  }
  for (const key of RESOURCE_KEYS) {
    if (!Array.isArray(settings[key])) continue;
    settings[key] = settings[key]
      .map(entry => resolveEntry(entry, baseDir, remote, warnings, key.slice(0, -1)))
      .filter(Boolean);
  }
  return settings;
}

function inlineSettings(piConfig, warnings) {
  const baseDir = appHome();
  return {
    packages: piConfig.packages
      .map(entry => resolveEntry(entry, baseDir, false, warnings, "package"))
      .filter(Boolean),
    extensions: piConfig.extensions
      .map(entry => resolveEntry(entry, baseDir, false, warnings, "extension"))
      .filter(Boolean),
  };
}

function addInlineResources(settings, inline) {
  const result = clone(settings);
  if (inline.packages.length) result.packages = unique([...(result.packages || []), ...inline.packages]);
  if (inline.extensions.length) result.extensions = unique([...(result.extensions || []), ...inline.extensions]);
  return result;
}

export function githubProfileSettingsUrl(input) {
  let url;
  try { url = new URL(input); } catch { return input; }
  if (url.hostname.toLowerCase() !== "github.com") return input;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return input;
  const [owner, rawRepo, marker, ref, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/, "");
  if (!marker) return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.pi/agent/settings.json`;
  if (marker === "blob" && ref && rest.length) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
  }
  if (marker === "tree" && ref) {
    const suffix = rest.length ? `${rest.join("/").replace(/\/$/, "")}/settings.json` : ".pi/agent/settings.json";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${suffix}`;
  }
  return input;
}

function profileLocation(source) {
  if (/^https:\/\//i.test(source)) {
    return { type: "url", requested: source, resolved: githubProfileSettingsUrl(source) };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error("Pi profile URLs must use HTTPS.");
  }
  let file = resolvePath(source.startsWith("~") || path.isAbsolute(source) ? source : path.join(appHome(), source));
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, "settings.json"); } catch { /* read reports a useful error */ }
  return { type: "file", requested: source, resolved: file };
}

async function readRemoteJson(url, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Pi profile URLs must be credential-free HTTPS URLs.");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname.toLowerCase())) throw new Error("Localhost Pi profile URLs are not allowed.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Profile request returned HTTP ${response.status}.`);
    if (response.url && new URL(response.url).protocol !== "https:") throw new Error("Pi profile URL redirected away from HTTPS.");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
    return JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Pi profile request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readLocalJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Pi profile must point to a settings.json file or profile directory.");
  if (stat.size > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function profileCachePath() { return path.join(appHome(), "pi-profile-cache.json"); }

function gitPackageSource(entry) {
  const source = sourceOf(entry)?.trim();
  if (!source?.startsWith("git:")) return null;
  let value = source.slice(4).trim();
  let host;
  let repoPath;
  if (value.startsWith("git@")) {
    const separator = value.indexOf(":", 4);
    if (separator < 0) return null;
    host = value.slice(4, separator);
    repoPath = value.slice(separator + 1);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch { return null; }
  } else {
    const separator = value.indexOf("/");
    if (separator < 1) return null;
    host = value.slice(0, separator);
    repoPath = value.slice(separator + 1);
  }
  repoPath = repoPath.replace(/\.git$/, "").replace(/@[^/]+$/, "");
  const parts = [host, ...repoPath.split("/")];
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\\\0]/.test(part))) return null;
  return parts;
}

// Pi's package manager cleans failed clones, but a process interruption can
// leave a non-repository directory behind. Remove only such directories for
// Git packages explicitly present in the selected profile/configuration.
export function recoverIncompleteGitPackages(agentDir, settings) {
  const recovered = [];
  for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
    const parts = gitPackageSource(entry);
    if (!parts) continue;
    const target = path.resolve(agentDir, "git", ...parts);
    const root = path.resolve(agentDir, "git");
    if (target === root || !target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) continue;
    if (fs.existsSync(path.join(target, ".git"))) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      recovered.push(target);
    } catch (error) {
      throw new Error(`Could not recover incomplete Pi package ${target}: ${publicError(error)}`, { cause: error });
    }
  }
  if (recovered.length) console.warn("pi-ez-web: recovered incomplete Pi package checkout(s)", recovered);
  return recovered;
}
function readProfileCache(location) {
  try {
    const cached = JSON.parse(fs.readFileSync(profileCachePath(), "utf8"));
    return cached?.source === location.requested && cached?.resolvedSource === location.resolved && isObject(cached.settings)
      ? cached : null;
  } catch { return null; }
}
function writeProfileCache(location, settings) {
  const file = profileCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      source: location.requested,
      resolvedSource: location.resolved,
      fetchedAt: new Date().toISOString(),
      settings,
    }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function publicError(error) {
  return String(error?.message || error || "Could not load Pi profile.")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}

class OverlaySettingsStorage {
  constructor(cwd, agentDir, overlay) {
    this.paths = {
      global: path.join(agentDir, "settings.json"),
      project: path.join(cwd, ".pi", "settings.json"),
    };
    this.overlay = overlay;
  }

  withLock(scope, fn) {
    const file = this.paths[scope];
    let original;
    try { original = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }

    let presented = original;
    let baseValue = {};
    let presentedValue;
    if (scope === "global") {
      // Preserve malformed JSON so SettingsManager can report the parse error
      // instead of silently replacing it with the imported profile.
      try {
        baseValue = original ? JSON.parse(original) : {};
        presentedValue = this.overlay(baseValue);
        presented = JSON.stringify(presentedValue, null, 2);
      } catch { /* SettingsManager owns parse diagnostics */ }
    }

    const next = fn(presented);
    if (next === undefined) return;

    let output = next;
    if (scope === "global" && presentedValue) {
      // Setters write the full settings object. Strip unchanged profile-owned
      // top-level values before persisting so a routine SDK setting change does
      // not copy the external profile permanently into local settings.json.
      try {
        const nextValue = JSON.parse(next);
        for (const key of new Set([...Object.keys(presentedValue), ...Object.keys(baseValue)])) {
          if (!same(nextValue[key], presentedValue[key])) continue;
          if (Object.hasOwn(baseValue, key)) nextValue[key] = baseValue[key];
          else delete nextValue[key];
        }
        output = JSON.stringify(nextValue, null, 2);
      } catch { /* persist the SDK-provided value and let future reads diagnose it */ }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export class PiConfiguration {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = null;
    this.runtime = null;
  }

  invalidate() {
    this.cache = null;
    this.runtime = null;
  }

  async resolve(piConfig = loadConfig().pi, { force = false } = {}) {
    const key = JSON.stringify(piConfig);
    if (!force && this.cache?.key === key) return this.cache.promise;
    const promise = this.#resolve(piConfig);
    this.cache = { key, promise };
    return promise;
  }

  async #resolve(piConfig) {
    const warnings = [];
    const inline = inlineSettings(piConfig, warnings);
    let settings = {};
    let profile = { status: "none", source: null, resolvedSource: null, error: null };

    if (piConfig.profile) {
      let location;
      try {
        location = profileLocation(piConfig.profile);
        const value = location.type === "url"
          ? await readRemoteJson(location.resolved, this.fetchImpl)
          : readLocalJson(location.resolved);
        if (!isObject(value)) throw new Error("Pi profile settings must contain a JSON object.");
        if (location.type === "url") {
          try { writeProfileCache(location, value); }
          catch (error) { warnings.push(`Could not cache Pi profile: ${publicError(error)}`); }
        }
        settings = prepareProfileSettings(value, {
          baseDir: location.type === "file" ? path.dirname(location.resolved) : appHome(),
          remote: location.type === "url",
          warnings,
        });
        profile = {
          status: "loaded",
          source: location.requested,
          resolvedSource: location.resolved,
          error: null,
          loadedAt: new Date().toISOString(),
        };
      } catch (error) {
        const cached = location?.type === "url" ? readProfileCache(location) : null;
        if (cached) {
          settings = prepareProfileSettings(cached.settings, { baseDir: appHome(), remote: true, warnings });
          warnings.push(`Using cached Pi profile because refresh failed: ${publicError(error)}`);
          profile = {
            status: "cached",
            source: location.requested,
            resolvedSource: location.resolved,
            error: publicError(error),
            loadedAt: cached.fetchedAt,
          };
        } else {
          profile = { status: "error", source: piConfig.profile, resolvedSource: null, error: publicError(error) };
        }
      }
    }

    const overlay = addInlineResources(settings, inline);
    // Package setup runs in managed Git checkouts that may contain mise.toml.
    // Use the image's system npm and avoid auto-installing peer dependency trees;
    // an explicitly supplied profile npmCommand remains authoritative.
    if (!Object.hasOwn(overlay, "npmCommand")) overlay.npmCommand = [...DEFAULT_NPM_COMMAND];
    return { piConfig: clone(piConfig), profile, settings: overlay, inline, warnings };
  }

  async createSettingsManager(cwd, agentDir, SettingsManager) {
    const resolved = await this.resolve();
    recoverIncompleteGitPackages(agentDir, resolved.settings);
    const storage = new OverlaySettingsStorage(cwd, agentDir, base => ["loaded", "cached"].includes(resolved.profile.status)
      ? mergeSettings(base, resolved.settings)
      : addInlineResources(base, resolved.inline));
    return { settingsManager: SettingsManager.fromStorage(storage), resolved };
  }

  recordRuntime(resourceLoader, extensionsResult) {
    this.runtime = {
      loadedAt: new Date().toISOString(),
      extensions: (extensionsResult.extensions || []).map(extension => ({
        path: extension.path || extension.resolvedPath || "<extension>",
        source: extension.sourceInfo?.source || null,
      })),
      errors: (extensionsResult.errors || []).map(error => ({ path: error.path, error: publicError(error.error) })),
      skills: resourceLoader.getSkills().skills.length,
      prompts: resourceLoader.getPrompts().prompts.length,
    };
  }

  recordRuntimeError(error) {
    this.runtime = { loadedAt: new Date().toISOString(), extensions: [], errors: [{ path: "<pi-configuration>", error: publicError(error) }], skills: 0, prompts: 0 };
  }

  async state(options) {
    const resolved = await this.resolve(undefined, options);
    return {
      config: resolved.piConfig,
      profile: resolved.profile,
      warnings: resolved.warnings,
      runtime: this.runtime,
      note: "Profiles import declarative settings and resources; credentials and sessions remain in PI_CODING_AGENT_DIR.",
    };
  }
}
