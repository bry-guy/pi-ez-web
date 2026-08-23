// Session lifecycle is deliberately independent of Git lifecycle.
// Closing archives the conversation only; worktrees and branches remain
// available to agents, terminals, and other sessions.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadBindings, loadClosed, loadConfig, saveBindings, saveClosed } from "./config.js";
import { sessionWorkspace, sessionsUsingWorkspace } from "./domain.js";
import * as ws from "./workspaces.js";


export function findProjectByWorkspace(wsPath) {
  const bindings = loadBindings();
  for (const p of loadConfig().projects) {
    const contexts = ws.listContexts(p.repoPath);
    const discovered = contexts.some(context => path.resolve(context.path) === path.resolve(wsPath));
    const retained = Object.values(bindings).some(binding => binding?.projectId === p.id && binding.workspacePath && path.resolve(binding.workspacePath) === path.resolve(wsPath));
    if (discovered || retained) {
      return { project: p, contexts, worktrees: Object.fromEntries(contexts.filter(context => context.branch).map(context => [context.branch, context.path])) };
    }
  }
  return null;
}

// Close one session. This is archival only and is allowed during a turn;
// stopping a turn remains an explicit user action.
export async function closeSession(_sup, hub, sessionId) {
  const closed = loadClosed();
  closed.add(sessionId);
  saveClosed(closed);
  hub.emit(sessionId, "session_closed", { sessionId });
  return { closed: true };
}

function failure(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Compatibility helpers retained for older API clients; branch workflows now
// use the explicit branch-context and merge-local routes.
export async function switchCheckoutToMain(sup, hub, project) {
  const primaryBranch = ws.defaultBranch(project.repoPath);
  const worktrees = ws.listWorktrees(project.repoPath);
  const mainPath = worktrees[primaryBranch];
  if (mainPath && path.resolve(mainPath) !== path.resolve(project.repoPath)) {
    throw failure("main_worktree_external", { workspacePath: mainPath });
  }
  const sessions = await sessionsUsingWorkspace(project, project.repoPath, sup);
  if (ws.currentBranch(project.repoPath) === primaryBranch) return { switched: false, sessions };
  if (ws.isDirty(project.repoPath)) throw failure("checkout_dirty");
  if (sessions.some(session => session.streaming)) throw failure("sessions_active");
  ws.switchWorkspace({ repoPath: project.repoPath, workspacePath: project.repoPath, branch: primaryBranch, primaryBranch });
  const bindings = loadBindings();
  for (const session of sessions) bindings[session.id] = { branch: primaryBranch, workspacePath: project.repoPath };
  saveBindings(bindings);
  for (const session of sessions) {
    hub.emit(session.id, "session_meta", { branch: primaryBranch });
    hub.emit(session.id, "workspace_switched", { branch: primaryBranch, workspacePath: project.repoPath });
  }
  return { switched: true, sessions };
}

export async function returnSessionToMain(sup, hub, sessionId) {
  if (sup.isStreaming(sessionId)) throw failure("session_streaming");
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw failure("no_project_for_session");
  const { project } = found;
  const primaryBranch = ws.defaultBranch(project.repoPath);
  const checkout = path.resolve(cwd) === path.resolve(project.repoPath);
  const result = await switchCheckoutToMain(sup, hub, project);
  if (checkout) return { ok: true, branch: primaryBranch, workspacePath: project.repoPath, switched: result.switched, returned: false };
  try { await sup.rehome(sessionId, project.repoPath); }
  catch (e) { throw failure("return_rehome_failed", { detail: String(e.message || e).slice(0, 400) }); }
  const bindings = loadBindings();
  bindings[sessionId] = { branch: primaryBranch, workspacePath: project.repoPath };
  saveBindings(bindings);
  hub.emit(sessionId, "session_meta", { branch: primaryBranch });
  hub.emit(sessionId, "session_returned", { branch: primaryBranch, workspacePath: project.repoPath });
  return { ok: true, branch: primaryBranch, workspacePath: project.repoPath, switched: result.switched, returned: true };
}

// Legacy Git mutation retained for old API clients; the current UI delegates
// merging to agents or the operator.
export async function mergeSession(sup, hub, sessionId) {
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw failure("no_project_for_session");
  const { project, worktrees } = found;
  const primaryBranch = ws.defaultBranch(project.repoPath);
  if (path.resolve(cwd) === path.resolve(project.repoPath)) throw failure("nothing_to_merge");
  const branch = Object.entries(worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0];
  if (!branch) throw failure("nothing_to_merge");
  if (branch === primaryBranch) throw failure("main_worktree_external", { workspacePath: cwd });
  const currentWorktrees = ws.listWorktrees(project.repoPath);
  const mainPath = currentWorktrees[primaryBranch];
  if (mainPath && path.resolve(mainPath) !== path.resolve(project.repoPath)) {
    throw failure("main_worktree_external", { workspacePath: mainPath });
  }
  if (ws.isDirty(project.repoPath)) throw failure("checkout_dirty");
  const checkoutSessions = await sessionsUsingWorkspace(project, project.repoPath, sup);
  if (checkoutSessions.some(session => session.streaming)) throw failure("sessions_active");
  const affected = await sessionsUsingWorkspace(project, cwd, sup);
  for (const session of affected) {
    if (sup.isStreaming(session.id)) await sup.stop(session.id);
  }
  if (affected.some(session => sup.isStreaming(session.id))) throw failure("sessions_active");

  await switchCheckoutToMain(sup, hub, project);
  try {
    execFileSync("git", ["merge", "--no-ff", branch, "-m", `Merge ${branch} (pi-web-ui)`],
      { cwd: project.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: project.repoPath }); } catch { /* no MERGE_HEAD */ }
    const error = failure("merge_conflict");
    error.detail = String(e.stderr || e.message || "").slice(0, 400);
    throw error;
  }

  const bindings = loadBindings();
  const moved = [];
  try {
    for (const session of affected) {
      await sup.rehome(session.id, project.repoPath);
      bindings[session.id] = { branch: primaryBranch, workspacePath: project.repoPath };
      saveBindings(bindings);
      moved.push(session);
      hub.emit(session.id, "session_meta", { branch: primaryBranch });
    }
  } catch (e) {
    const error = failure("merge_rehome_failed", { detail: String(e.message || e).slice(0, 400) });
    throw error;
  }

  try {
    ws.removeWorkspace({ repoPath: project.repoPath, workspacePath: cwd, force: true });
    execFileSync("git", ["branch", "-D", branch], { cwd: project.repoPath });
  } catch (e) {
    throw failure("merge_cleanup_failed", { detail: String(e.message || e).slice(0, 400) });
  }
  for (const session of moved) {
    hub.emit(session.id, "session_merged", { sessionId: session.id, branch, into: primaryBranch });
  }
  return { merged: branch, into: primaryBranch, sessionIds: affected.map(session => session.id) };
}
