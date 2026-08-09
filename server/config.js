// Config + app-home paths. App state discipline: config.json (declarative,
// user- and UI-editable) + bindings.json (session -> workspace overrides).
// Everything else is discovered live or owned by pi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function appHome() {
  return process.env.PI_WEB_HOME || path.join(os.homedir(), ".pi-web-ui");
}
export const chatsDir = () => path.join(appHome(), "chats");
export const worktreeRootDefault = () => path.join(appHome(), "worktrees");
const configPath = () => path.join(appHome(), "config.json");
const bindingsPath = () => path.join(appHome(), "bindings.json");

const DEFAULTS = {
  projects: [], // { id, name, repoPath, setup? }
  worktreeRoot: null, // null -> worktreeRootDefault()
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
  return readJson(bindingsPath(), {});
}
export function saveBindings(b) {
  writeJson(bindingsPath(), b);
}

export function slug(s) {
  return String(s).trim().replace(/\s+/g, "-").replace(/[^\w./-]/g, "-");
}
export function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
