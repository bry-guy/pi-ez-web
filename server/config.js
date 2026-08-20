// Config + app-home paths. App state discipline: config.json (declarative,
// user- and UI-editable) + bindings.json (session -> { branch, workspacePath } overrides).
// Everything else is discovered live or owned by pi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function appHome() {
  return process.env.PI_WEB_HOME || path.join(os.homedir(), ".pi-web-ui");
}
export const chatsDir = () => path.join(appHome(), "chats");
export const worktreeRootDefault = () => path.join(os.homedir(), ".pi", "worktrees");
const configPath = () => path.join(appHome(), "config.json");
const bindingsPath = () => path.join(appHome(), "bindings.json");

const DEFAULTS = {
  projects: [], // { id, name, repoPath, hooks?, mode? }
  projectHooks: {}, // deployment-wide hook defaults, overridden per project
  projectHookSets: {}, // deployment hook defaults keyed by project name
  worktreeRoot: null, // null -> worktreeRootDefault()
  reposRoot: null, // null -> ~/src; env PI_WEB_REPOS_ROOT still overrides
  port: 3141,
  defaultModel: null,
  defaultThinkingLevel: "medium",
  pi: {
    profile: null, // local profile dir/settings.json or HTTPS settings URL
    packages: [], // additional Pi package sources
    extensions: [], // additional package sources or server-local extension paths
  },
  repositorySources: {
    default: "local",
    github: { clientId: null, owner: null },
  },
};

export function normalizeHooks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const hooks = {};
  for (const [name, command] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)) continue;
    if (command === null) hooks[name] = null;
    else if (typeof command === "string" && command.trim()) hooks[name] = command.trim();
  }
  return hooks;
}

export function normalizeHookSets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sets = {};
  for (const [projectName, hooks] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName)) continue;
    sets[projectName] = normalizeHooks(hooks);
  }
  return sets;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeThinkingLevel(value, { strict = false } = {}) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (THINKING_LEVELS.includes(level)) return level;
  if (strict) throw Object.assign(new Error(`Invalid thinking level: ${value}`), { code: "invalid_thinking_level" });
  return "medium";
}

export function normalizePiConfig(value, { strict = false } = {}) {
  const invalid = message => {
    if (strict) throw Object.assign(new Error(message), { code: "invalid_pi_configuration" });
    return { ...DEFAULTS.pi };
  };
  if (value == null) return { ...DEFAULTS.pi };
  if (typeof value !== "object" || Array.isArray(value)) return invalid("Pi configuration must be an object.");
  if (value.profile !== undefined && value.profile !== null && typeof value.profile !== "string") return invalid("Pi profile must be a path or HTTPS URL.");
  for (const key of ["packages", "extensions"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(entry => typeof entry !== "string"))) {
      return invalid(`Pi ${key} must be an array of strings.`);
    }
  }
  return {
    profile: typeof value.profile === "string" && value.profile.trim() ? value.profile.trim() : null,
    packages: [...new Set((value.packages || []).map(entry => entry.trim()).filter(Boolean))],
    extensions: [...new Set((value.extensions || []).map(entry => entry.trim()).filter(Boolean))],
  };
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (error) {
    if (fs.existsSync(p)) console.warn(`pi-ez-web: could not read JSON state ${p}: ${error.message}`);
    return fallback;
  }
}
function writeJson(p, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temporary = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temporary, p);
    try { fs.chmodSync(p, mode); } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function ensureHome() {
  fs.mkdirSync(chatsDir(), { recursive: true });
}

export function loadConfig() {
  const rawValue = readJson(configPath(), {});
  const raw = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
  const sources = raw.repositorySources && typeof raw.repositorySources === "object" ? raw.repositorySources : {};
  const github = sources.github && typeof sources.github === "object" ? sources.github : {};
  const projects = Array.isArray(raw.projects) ? raw.projects : DEFAULTS.projects;
  return {
    ...DEFAULTS,
    ...raw,
    projects,
    projectHooks: normalizeHooks(raw.projectHooks),
    projectHookSets: normalizeHookSets(raw.projectHookSets),
    defaultThinkingLevel: normalizeThinkingLevel(raw.defaultThinkingLevel),
    pi: normalizePiConfig(raw.pi),
    repositorySources: {
      ...DEFAULTS.repositorySources,
      ...sources,
      default: ["local", "github", "git-url"].includes(sources.default) ? sources.default : DEFAULTS.repositorySources.default,
      github: {
        ...DEFAULTS.repositorySources.github,
        ...github,
        clientId: github.clientId ? String(github.clientId).trim() : null,
        owner: github.owner ? String(github.owner).trim() : null,
      },
    },
  };
}
export function saveConfig(cfg) {
  writeJson(configPath(), cfg);
  return cfg;
}
export function resolvePath(raw) {
  let value = String(raw).trim().replace(/^~(?=$|\/)/, os.homedir());
  // Be forgiving of the common macOS shell typo `Users/name/...` when the
  // intended path is `/Users/name/...`; ordinary relative paths still resolve
  // from the process working directory.
  if (process.platform === "darwin" && value.startsWith("Users/")) value = `/${value}`;
  return path.resolve(value);
}

export function reposRoot(cfg = loadConfig()) {
  const raw = process.env.PI_WEB_REPOS_ROOT || cfg.reposRoot || path.join(os.homedir(), "src");
  return resolvePath(raw);
}

export function repositorySource(cfg = loadConfig()) {
  const value = process.env.PI_WEB_REPOSITORY_SOURCE || cfg.repositorySources?.default || "local";
  return ["local", "github", "git-url"].includes(value) ? value : "local";
}

export function githubConfig(cfg = loadConfig()) {
  const configured = cfg.repositorySources?.github || {};
  return {
    clientId: process.env.PI_WEB_GITHUB_CLIENT_ID || configured.clientId || null,
    owner: process.env.PI_WEB_GITHUB_OWNER || configured.owner || null,
  };
}

export function worktreeRoot(cfg) {
  return cfg.worktreeRoot || worktreeRootDefault();
}

const closedPath = () => path.join(appHome(), "closed.json");
export function loadClosed() {
  try { return new Set(JSON.parse(fs.readFileSync(closedPath(), "utf8"))); } catch { return new Set(); }
}
export function saveClosed(set) {
  writeJson(closedPath(), [...set]);
}

export function loadBindings() {
  const bindings = readJson(bindingsPath(), {});
  let migrated = false;
  for (const [sessionId, value] of Object.entries(bindings)) {
    if (typeof value === "string") {
      bindings[sessionId] = { branch: null, workspacePath: value };
      migrated = true;
    }
  }
  if (migrated) saveBindings(bindings);
  return bindings;
}
export function saveBindings(b) {
  writeJson(bindingsPath(), b);
}

export function projectMode(project) {
  return project?.mode === "auto" || project?.mode === "manual" ? project.mode : "manual";
}

export function sessionSlug(firstMessage) {
  const slug = String(firstMessage || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `session/${slug || "chat"}`;
}

export function slug(s) {
  return String(s).trim().replace(/\s+/g, "-").replace(/[^\w./-]/g, "-");
}
export function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
