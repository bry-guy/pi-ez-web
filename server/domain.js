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

function reconcileBindings(cfg, project, worktrees, bindings) {
  const currentPaths = new Set([project.repoPath, ...Object.values(worktrees)].map(pathKey));
  const otherPaths = new Set();
  for (const candidate of cfg.projects) {
    if (candidate.id === project.id) continue;
    otherPaths.add(pathKey(candidate.repoPath));
    try {
      for (const workspacePath of Object.values(ws.listWorktrees(candidate.repoPath))) otherPaths.add(pathKey(workspacePath));
    } catch { /* malformed or removed project repo */ }
  }
  let changed = false;
  for (const [sessionId, binding] of Object.entries(bindings)) {
    const workspacePath = binding?.workspacePath;
    const key = pathKey(workspacePath);
    if (!workspacePath || (!currentPaths.has(key) && !otherPaths.has(key))) {
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
  reconcileBindings(cfg, project, worktrees, bindings);
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
  const toNode = n => ({
    id: n.id,
    title: titleOf(n),
    branch: pathToBranch[n.cwd] || null,
    workspacePath: n.cwd || null,
    streaming: sup.isStreaming(n.id),
    model: n.model || null,
    when: rel(n.modified),
    children: n.children.sort(byRecency).map(toNode),
  });

  return {
    id: project.id,
    name: project.name,
    repoPath: project.repoPath,
    branch: ws.currentBranch(project.repoPath),
    branches: ws.listBranches(project.repoPath),
    worktrees,
    occupied,
    sessions: roots.sort(byRecency).map(toNode),
    updated: all.length ? rel(all.map(s => s.modified).sort().pop()) : "—",
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
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
    .map(s => ({ id: s.id, title: titleOf(s), when: rel(s.modified), streaming: sup.isStreaming(s.id), model: s.model || null }));
}

export function titleOf(s) {
  return s.name || (s.firstMessage ? s.firstMessage.slice(0, 48) : "New session");
}

function byRecency(a, b) { return String(b.modified).localeCompare(String(a.modified)); }

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
