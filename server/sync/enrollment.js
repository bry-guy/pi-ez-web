import fs from "node:fs";
import path from "node:path";
import { appHome } from "../config.js";

const FILE_NAME = "sync-sessions.json";
const VERSION = 1;

export function syncSessionsPath() {
  return path.join(appHome(), FILE_NAME);
}

function validIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === "string" && id.trim()).map(id => id.trim()))];
}

function normalize(value) {
  // Accept the early array form so a future format change cannot silently
  // forget conversations that were already enrolled.
  if (Array.isArray(value)) return { version: VERSION, enrolled: validIds(value), pending: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: VERSION, enrolled: [], pending: [] };
  }
  const enrolled = validIds(value.enrolled);
  const pending = validIds(value.pending).filter(id => !enrolled.includes(id));
  return { version: VERSION, enrolled, pending };
}

export function loadSyncSessions() {
  try {
    return normalize(JSON.parse(fs.readFileSync(syncSessionsPath(), "utf8")));
  } catch {
    return { version: VERSION, enrolled: [], pending: [] };
  }
}

export function saveSyncSessions(value) {
  const state = normalize(value);
  const file = syncSessionsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return state;
}

export function isSyncEnrolled(sessionId) {
  return loadSyncSessions().enrolled.includes(String(sessionId));
}

export function markSyncEnrolled(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new TypeError("A session id is required.");
  const state = loadSyncSessions();
  if (!state.enrolled.includes(id)) state.enrolled.push(id);
  state.pending = state.pending.filter(candidate => candidate !== id);
  return saveSyncSessions(state);
}

export function markSyncPending(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new TypeError("A session id is required.");
  const state = loadSyncSessions();
  if (!state.enrolled.includes(id) && !state.pending.includes(id)) state.pending.push(id);
  return saveSyncSessions(state);
}

export function clearSyncPending(sessionId) {
  const id = String(sessionId || "").trim();
  const state = loadSyncSessions();
  state.pending = state.pending.filter(candidate => candidate !== id);
  return saveSyncSessions(state);
}
