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
  projects: [], // { id, name, repoPath, setup? }
  worktreeRoot: null, // null -> worktreeRootDefault()
  reposRoot: null, // null -> ~/src; env PI_WEB_REPOS_ROOT still overrides
  port: 3141,
  defaultModel: null,
};

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

export function ensureHome() {
  fs.mkdirSync(chatsDir(), { recursive: true });
}

export function loadConfig() {
  return { ...DEFAULTS, ...readJson(configPath(), {}) };
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

export function worktreeRoot(cfg) {
  return cfg.worktreeRoot || worktreeRootDefault();
}

const closedPath = () => path.join(appHome(), "closed.json");
export function loadClosed() {
  try { return new Set(JSON.parse(fs.readFileSync(closedPath(), "utf8"))); } catch { return new Set(); }
}
export function saveClosed(set) {
  fs.mkdirSync(appHome(), { recursive: true });
  fs.writeFileSync(closedPath(), JSON.stringify([...set], null, 2) + "\n");
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
