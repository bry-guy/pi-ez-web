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
    if (shared.length <= 1) {
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

// Merge a shared worktree into the checkout. Active sessions are stopped first;
// checkout changes still block the operation, while source worktree changes are
// discarded only after the caller has confirmed the destructive action.
export async function mergeSession(sup, hub, sessionId) {
  const fail = code => Object.assign(new Error(code), { code });
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw fail("no_project_for_session");
  const { project, worktrees } = found;
  if (path.resolve(cwd) === path.resolve(project.repoPath)) throw fail("nothing_to_merge");
  const branch = Object.entries(worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0];
  if (!branch) throw fail("nothing_to_merge");

  const affected = await sessionsUsingWorkspace(project, cwd, sup);
  for (const session of affected) {
    if (sup.isStreaming(session.id)) await sup.stop(session.id);
  }
  if (affected.some(session => sup.isStreaming(session.id))) throw fail("sessions_active");
  if (ws.isDirty(project.repoPath)) throw fail("checkout_dirty");
  const target = ws.currentBranch(project.repoPath);

  try {
    execFileSync("git", ["merge", "--no-ff", branch, "-m", `Merge ${branch} (pi-web-ui)`],
      { cwd: project.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: project.repoPath }); } catch { /* no MERGE_HEAD */ }
    const error = fail("merge_conflict");
    error.detail = String(e.stderr || e.message || "").slice(0, 400);
    throw error;
  }

  try {
    for (const session of affected) await sup.rehome(session.id, project.repoPath);
  } catch (e) {
    const error = fail("merge_rehome_failed");
    error.detail = String(e.message || e).slice(0, 400);
    throw error;
  }
  const bindings = loadBindings();
  for (const session of affected) bindings[session.id] = { branch: target, workspacePath: project.repoPath };
  saveBindings(bindings);
  ws.removeWorkspace({ repoPath: project.repoPath, workspacePath: cwd, force: true });
  execFileSync("git", ["branch", "-D", branch], { cwd: project.repoPath });
  for (const session of affected) {
    hub.emit(session.id, "session_merged", { sessionId: session.id, branch, into: target });
    hub.emit(session.id, "session_meta", { branch: target });
  }
  return { merged: branch, into: target, sessionIds: affected.map(session => session.id) };
}
