// Session/workspace lifecycle: explicit close and merge.
//
// Closing hides the session and preserves its transcript. A worktree is removed
// only when the closed session is the last session using it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadBindings, loadClosed, loadConfig, saveBindings, saveClosed } from "./config.js";
import { sessionWorkspace, sessionsUsingWorkspace } from "./domain.js";
import * as ws from "./workspaces.js";


export function findProjectByWorkspace(wsPath) {
  for (const p of loadConfig().projects) {
    const map = ws.listWorktrees(p.repoPath);
    if (Object.values(map).some(workspacePath => path.resolve(workspacePath) === path.resolve(wsPath))) return { project: p, worktrees: map };
  }
  return null;
}

// Close one session. Throws { code: "session_streaming" }.
// Semantics follow workspace type, not lineage:
//  - checkout session (or plain chat): archival only — nothing in git is
//    touched; the session's branch is the checkout's branch and survives.
//  - last worktree session: DESTRUCTIVE — worktree removed (force) and the
//    branch force-deleted. Shared workspaces stay available to their siblings.
//    Transcript always survives (closed is a marker).
export async function closeSession(sup, hub, sessionId) {
  if (sup.isStreaming(sessionId)) {
    throw Object.assign(new Error("session_streaming"), { code: "session_streaming" });
  }
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (found && path.resolve(cwd) !== path.resolve(found.project.repoPath)) {
    const branch = Object.entries(found.worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0];
    const shared = await sessionsUsingWorkspace(found.project, cwd, sup);
    if (shared.length <= 1 && branch !== ws.MAIN_BRANCH) {
      ws.removeWorkspace({ repoPath: found.project.repoPath, workspacePath: cwd, force: true });
      if (branch) {
        try { execFileSync("git", ["branch", "-D", branch], { cwd: found.project.repoPath }); } catch { /* already gone */ }
      }
    }
  }
  const closed = loadClosed();
  closed.add(sessionId);
  saveClosed(closed);
  const bindings = loadBindings();
  if (bindings[sessionId]) { delete bindings[sessionId]; saveBindings(bindings); }
  hub.emit(sessionId, "session_closed", { sessionId });
  return { closed: true };
}

function failure(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

export async function switchCheckoutToMain(sup, hub, project) {
  const worktrees = ws.listWorktrees(project.repoPath);
  const mainPath = worktrees[ws.MAIN_BRANCH];
  if (mainPath && path.resolve(mainPath) !== path.resolve(project.repoPath)) {
    throw failure("main_worktree_external", { workspacePath: mainPath });
  }
  const sessions = await sessionsUsingWorkspace(project, project.repoPath, sup);
  if (ws.currentBranch(project.repoPath) === ws.MAIN_BRANCH) return { switched: false, sessions };
  if (ws.isDirty(project.repoPath)) throw failure("checkout_dirty");
  if (sessions.some(session => session.streaming)) throw failure("sessions_active");
  ws.switchWorkspace({ repoPath: project.repoPath, workspacePath: project.repoPath, branch: ws.MAIN_BRANCH });
  const bindings = loadBindings();
  for (const session of sessions) bindings[session.id] = { branch: ws.MAIN_BRANCH, workspacePath: project.repoPath };
  saveBindings(bindings);
  for (const session of sessions) {
    hub.emit(session.id, "session_meta", { branch: ws.MAIN_BRANCH });
    hub.emit(session.id, "workspace_switched", { branch: ws.MAIN_BRANCH, workspacePath: project.repoPath });
  }
  return { switched: true, sessions };
}

export async function returnSessionToMain(sup, hub, sessionId) {
  if (sup.isStreaming(sessionId)) throw failure("session_streaming");
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw failure("no_project_for_session");
  const { project } = found;
  const checkout = path.resolve(cwd) === path.resolve(project.repoPath);
  const result = await switchCheckoutToMain(sup, hub, project);
  if (checkout) return { ok: true, branch: ws.MAIN_BRANCH, workspacePath: project.repoPath, switched: result.switched, returned: false };
  try { await sup.rehome(sessionId, project.repoPath); }
  catch (e) { throw failure("return_rehome_failed", { detail: String(e.message || e).slice(0, 400) }); }
  const bindings = loadBindings();
  bindings[sessionId] = { branch: ws.MAIN_BRANCH, workspacePath: project.repoPath };
  saveBindings(bindings);
  hub.emit(sessionId, "session_meta", { branch: ws.MAIN_BRANCH });
  hub.emit(sessionId, "session_returned", { branch: ws.MAIN_BRANCH, workspacePath: project.repoPath });
  return { ok: true, branch: ws.MAIN_BRANCH, workspacePath: project.repoPath, switched: result.switched, returned: true };
}

export async function mergeSession(sup, hub, sessionId) {
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw failure("no_project_for_session");
  const { project, worktrees } = found;
  if (path.resolve(cwd) === path.resolve(project.repoPath)) throw failure("nothing_to_merge");
  const branch = Object.entries(worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0];
  if (!branch) throw failure("nothing_to_merge");
  if (branch === ws.MAIN_BRANCH) throw failure("main_worktree_external", { workspacePath: cwd });
  const currentWorktrees = ws.listWorktrees(project.repoPath);
  const mainPath = currentWorktrees[ws.MAIN_BRANCH];
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
      bindings[session.id] = { branch: ws.MAIN_BRANCH, workspacePath: project.repoPath };
      saveBindings(bindings);
      moved.push(session);
      hub.emit(session.id, "session_meta", { branch: ws.MAIN_BRANCH });
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
    hub.emit(session.id, "session_merged", { sessionId: session.id, branch, into: ws.MAIN_BRANCH });
  }
  return { merged: branch, into: ws.MAIN_BRANCH, sessionIds: affected.map(session => session.id) };
}
