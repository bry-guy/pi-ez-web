// Assembles the /api/state shape: projects with branches + session trees,
// occupied map, plain chats. Session->project/branch is derived from cwd
// (bindings.json overrides for re-homed sessions).
import { chatsDir, loadBindings, loadClosed, loadConfig, worktreeRoot } from "./config.js";
import * as ws from "./workspaces.js";

export async function sessionWorkspace(sessionId, sup) {
  const bindings = loadBindings();
  if (bindings[sessionId]) return bindings[sessionId];
  const meta = await sup.meta(sessionId);
  return meta?.cwd || null;
}

export async function projectState(project, sup) {
  const cfg = loadConfig();
  const bindings = loadBindings();
  const worktrees = ws.listWorktrees(project.repoPath); // branch -> path
  const pathToBranch = Object.fromEntries(Object.entries(worktrees).map(([b, p]) => [p, b]));

  // Sessions across all of this project's workspaces (closed ones hidden).
  const closed = loadClosed();
  const all = [];
  for (const wt of Object.values(worktrees)) {
    for (const s of await sup.listSessions(wt)) {
      if (closed.has(s.id)) continue;
      all.push({ ...s, cwd: bindings[s.id] || s.cwd });
    }
  }
  // occupied: branch -> sessionId (first bound session wins for display)
  const occupied = {};
  for (const s of all) {
    const b = pathToBranch[s.cwd];
    if (b && !occupied[b]) occupied[b] = { sessionId: s.id, title: titleOf(s) };
  }

  // Session tree from fork lineage.
  const byId = new Map(all.map(s => [s.id, { ...s, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentSessionId && byId.get(node.parentSessionId);
    (parent ? parent.children : roots).push(node);
  }
  const toNode = n => ({
    id: n.id,
    title: titleOf(n),
    branch: pathToBranch[n.cwd] || null,
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
  };
}

export async function chatsState(sup) {
  const closed = loadClosed();
  const list = (await sup.listSessions(chatsDir())).filter(s => !closed.has(s.id));
  return list
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
    .map(s => ({ id: s.id, title: titleOf(s), when: rel(s.modified) }));
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
