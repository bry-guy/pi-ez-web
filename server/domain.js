// Assembles the /api/state shape: projects with branches + session trees,
// occupied map, plain chats. Session->project/branch is derived from cwd
// (bindings.json overrides for re-homed sessions).
import fs from "node:fs";
import path from "node:path";
import { chatsDir, loadBindings, loadClosed, loadConfig, projectMode, saveBindings, worktreeRoot } from "./config.js";
import * as ws from "./workspaces.js";

export async function sessionWorkspace(sessionId, sup) {
  const bindings = loadBindings();
  if (bindings[sessionId]?.workspacePath) return bindings[sessionId].workspacePath;
  const meta = await sup.meta(sessionId);
  return meta?.cwd || null;
}

function pathKey(value) {
  try { return path.resolve(value); } catch { return String(value || ""); }
}

export function reconcileBindings(cfg, bindings) {
  const valid = new Set();
  for (const project of cfg.projects) {
    valid.add(pathKey(project.repoPath));
    try {
      for (const p of Object.values(ws.listWorktrees(project.repoPath))) valid.add(pathKey(p));
    } catch { /* malformed or removed project repo */ }
  }
  let changed = false;
  for (const [sessionId, binding] of Object.entries(bindings)) {
    if (!binding?.workspacePath || !valid.has(pathKey(binding.workspacePath))) {
      delete bindings[sessionId];
      changed = true;
    }
  }
  if (changed) saveBindings(bindings);
}

export async function projectState(project, sup) {
  const cfg = loadConfig();
  const bindings = loadBindings();
  const worktrees = ws.listWorktrees(project.repoPath); // branch -> path
  const pathToBranch = Object.fromEntries(Object.entries(worktrees).map(([b, p]) => [p, b]));

  // Discover all sessions first, including closed nodes. Closed sessions stay
  // available as lineage anchors so closing a middle node does not re-root its
  // children. They are removed only when the visible tree is assembled.
  const closed = loadClosed();
  const discovered = [];
  for (const wt of Object.values(worktrees)) {
    for (const s of await sup.listSessions(wt)) {
      discovered.push({ ...s, cwd: bindings[s.id]?.workspacePath || s.cwd, closed: closed.has(s.id) });
    }
  }
  const all = discovered.filter(s => !s.closed);
  // occupied: branch -> sessionId (first bound session wins for display)
  const occupied = {};
  for (const s of all) {
    const b = pathToBranch[s.cwd];
    if (b && !occupied[b]) occupied[b] = { sessionId: s.id, title: titleOf(s) };
  }

  // Session tree from fork lineage. Walk through closed ancestors so visible
  // descendants occupy the closed node's former position.
  const byId = new Map(discovered.map(s => [s.id, { ...s, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.closed) continue;
    let parent = node.parentSessionId && byId.get(node.parentSessionId);
    while (parent?.closed) parent = parent.parentSessionId && byId.get(parent.parentSessionId);
    (parent ? parent.children : roots).push(node);
  }
  const toNode = n => {
    const children = n.children.sort(byRecency).map(toNode);
    const updatedAt = isoTime(n.modified);
    const activityAt = children.reduce((latest, child) => newerTimestamp(latest, child.activityAt), updatedAt);
    return {
      id: n.id,
      title: titleOf(n),
      branch: pathToBranch[n.cwd] || null,
      workspacePath: n.cwd || null,
      streaming: sup.isStreaming(n.id),
      model: n.model || null,
      when: rel(n.modified),
      updatedAt,
      activityAt,
      children,
    };
  };

  const sessions = roots.sort((a, b) => compareTimestamp(treeActivity(b), treeActivity(a))).map(toNode);
  const updatedAt = all.reduce((latest, session) => newerTimestamp(latest, isoTime(session.modified)), null);

  return {
    id: project.id,
    name: project.name,
    repoPath: project.repoPath,
    source: project.source || { type: "local" },
    branch: ws.currentBranch(project.repoPath),
    branches: ws.listBranches(project.repoPath),
    worktrees,
    occupied,
    sessions,
    updated: updatedAt ? rel(updatedAt) : "—",
    updatedAt,
    worktreeRoot: worktreeRoot(cfg),
    mode: projectMode(project),
    modeInvalid: project.mode !== undefined && project.mode !== "manual" && project.mode !== "auto",
  };
}

export async function chatsState(sup) {
  const root = chatsDir();
  const cwds = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) cwds.push(path.join(root, entry.name));
    }
  } catch { /* ensureHome normally creates this; discovery stays best-effort */ }

  const discovered = [];
  for (const cwd of cwds) {
    try { discovered.push(...await sup.listSessions(cwd)); }
    catch { /* ignore an empty or malformed scratch directory */ }
  }
  const closed = loadClosed();
  const list = discovered.filter(s => !closed.has(s.id));
  return list
    .sort((a, b) => compareTimestamp(b.modified, a.modified))
    .map(s => ({
      id: s.id,
      title: titleOf(s),
      when: rel(s.modified),
      updatedAt: isoTime(s.modified),
      activityAt: isoTime(s.modified),
      streaming: sup.isStreaming(s.id),
      model: s.model || null,
    }));
}

export function titleOf(s) {
  return s.name || truncateSessionStart(s.firstMessage);
}

export function truncateSessionStart(value, max = 48) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : "New session";
}

export function timestampValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isoTime(value) {
  const timestamp = timestampValue(value);
  return timestamp ? new Date(timestamp).toISOString() : null;
}

export function compareTimestamp(a, b) {
  const delta = timestampValue(a) - timestampValue(b);
  return delta || String(a || "").localeCompare(String(b || ""));
}

export function newerTimestamp(a, b) {
  return timestampValue(a) >= timestampValue(b) ? (a || null) : (b || null);
}

function treeActivity(node) {
  return (node.children || []).reduce((latest, child) => newerTimestamp(latest, treeActivity(child)), node.modified);
}

function byRecency(a, b) { return compareTimestamp(b.modified, a.modified); }

export function rel(ts) {
  if (!ts) return "";
  const d = Date.now() - new Date(ts).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const days = Math.floor(h / 24);
  if (days < 7) return days + "d";
  return Math.floor(days / 7) + "w";
}
