// Session/workspace lifecycle: explicit close, and the merge sweep.
//
// Close ≠ discard: closing removes the worktree (working copy) and hides the
// session, but keeps the git branch (commits stay reachable) and pi's JSONL
// transcript (pi owns it; "closed" is only a marker in closed.json).
//
// The sweep is a job inside the server process, not a daemon: on startup and
// every sweepMinutes, per project — optionally fetch, find branches merged
// into the default branch, and reap each one whose worktree is clean and
// whose session is idle: close session, remove worktree, `git branch -d`
// (safe delete only). Dirty or mid-turn -> skipped, never auto-deleted.
// Squash merges are NOT detected (the branch never becomes an ancestor);
// those take the explicit close path.
import { execFileSync } from "node:child_process";
import { loadBindings, loadClosed, loadConfig, saveBindings, saveClosed } from "./config.js";
import { sessionWorkspace } from "./domain.js";
import * as ws from "./workspaces.js";


export function findProjectByWorkspace(wsPath) {
  for (const p of loadConfig().projects) {
    const map = ws.listWorktrees(p.repoPath);
    if (Object.values(map).includes(wsPath)) return { project: p, worktrees: map };
  }
  return null;
}

// Close one session. Throws { code: "session_streaming" }.
// Semantics follow workspace type, not lineage:
//  - checkout session (or plain chat): archival only — nothing in git is
//    touched; the session's branch is the checkout's branch and survives.
//  - worktree session: DESTRUCTIVE — worktree removed (force) and the branch
//    force-deleted. The UI's confirmation dialog is the guard; throwaway
//    means throwaway. Transcript always survives (closed is a marker).
// removeWorktree=false marks closed without touching the working copy (used
// by the sweep, which removes the worktree once per branch afterwards).
export async function closeSession(sup, hub, sessionId, { removeWorktree = true } = {}) {
  if (sup.isStreaming(sessionId)) {
    throw Object.assign(new Error("session_streaming"), { code: "session_streaming" });
  }
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (removeWorktree && found && cwd !== found.project.repoPath) {
    const branch = Object.entries(found.worktrees).find(([, p]) => p === cwd)?.[0];
    ws.removeWorkspace({ repoPath: found.project.repoPath, workspacePath: cwd, force: true });
    if (branch) {
      try { execFileSync("git", ["branch", "-D", branch], { cwd: found.project.repoPath }); } catch { /* already gone */ }
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

// Merge the session's branch into the checkout's current branch, then clean
// up. The ONE sanctioned mutation of the user's checkout: landing work into
// the default branch requires its working copy, and that is the user's
// explicit intent behind the merge button.
//
//   preflight   session idle · session on a worktree · worktree clean ·
//               checkout clean
//   merge       `git merge --no-ff <branch>` in the checkout (an explicit
//               merge commit records the session's work as a unit)
//   conflict    `git merge --abort` -> checkout restored, branch and worktree
//               untouched, 409 merge_conflict
//   success     worktree removed, branch -d (safe delete re-verifies merged),
//               session re-homed to the checkout — it continues on the
//               default branch. Exemption to one-session-per-workspace:
//               merge may co-home sessions on the checkout; the per-workspace
//               turn lock still serializes agent runs there.
export async function mergeSession(sup, hub, sessionId) {
  const fail = code => Object.assign(new Error(code), { code });
  if (sup.isStreaming(sessionId)) throw fail("session_streaming");
  const cwd = await sessionWorkspace(sessionId, sup);
  const found = cwd && findProjectByWorkspace(cwd);
  if (!found) throw fail("no_project_for_session");
  const { project, worktrees } = found;
  if (cwd === project.repoPath) throw fail("nothing_to_merge");
  const branch = Object.entries(worktrees).find(([, p]) => p === cwd)?.[0];
  if (!branch) throw fail("nothing_to_merge");
  if (ws.isDirty(cwd)) throw fail("workspace_dirty");
  if (ws.isDirty(project.repoPath)) throw fail("checkout_dirty");
  const target = ws.currentBranch(project.repoPath);

  try {
    execFileSync("git", ["merge", "--no-ff", branch, "-m", `Merge ${branch} (pi-web-ui)`],
      { cwd: project.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: project.repoPath }); } catch { /* no MERGE_HEAD */ }
    const err = fail("merge_conflict");
    err.detail = String(e.stderr || e.message || "").slice(0, 400);
    throw err;
  }

  ws.removeWorkspace({ repoPath: project.repoPath, workspacePath: cwd });
  execFileSync("git", ["branch", "-d", branch], { cwd: project.repoPath });
  await sup.rehome(sessionId, project.repoPath);
  const bindings = loadBindings();
  bindings[sessionId] = { branch: target, workspacePath: project.repoPath };
  saveBindings(bindings);
  hub.emit(sessionId, "session_merged", { sessionId, branch, into: target });
  hub.emit(sessionId, "session_meta", { branch: target });
  return { merged: branch, into: target };
}

function mergedBranches(repoPath, into) {
  try {
    return execFileSync("git", ["branch", "--merged", into, "--format=%(refname:short)"],
      { cwd: repoPath, encoding: "utf8" })
      .split("\n").map(s => s.trim()).filter(b => b && b !== into);
  } catch { return []; }
}

function tryFetch(repoPath) {
  try {
    const remotes = execFileSync("git", ["remote"], { cwd: repoPath, encoding: "utf8" }).trim();
    if (!remotes) return;
    execFileSync("git", ["fetch", "--prune", "--quiet"], { cwd: repoPath, timeout: 30000 });
  } catch { /* offline / no auth: sweep proceeds on local refs */ }
}

// Returns { reaped: [{branch, sessions}], skipped: [{branch, reason}] }.
export async function sweepProject(sup, hub, project, { fetch = true } = {}) {
  const reaped = [], skipped = [];
  if (fetch) tryFetch(project.repoPath);
  const def = ws.currentBranch(project.repoPath);
  if (!def) return { reaped, skipped };
  const worktrees = ws.listWorktrees(project.repoPath);
  const bindings = loadBindings();
  const closed = loadClosed();

  for (const branch of mergedBranches(project.repoPath, def)) {
    const wt = worktrees[branch];
    if (!wt || wt === project.repoPath) continue;           // no worktree, or it's the checkout
    if (ws.isDirty(wt)) { skipped.push({ branch, reason: "dirty" }); continue; }

    const bound = (await sup.listSessions(wt))
      .filter(s => !closed.has(s.id) && (bindings[s.id]?.workspacePath || s.cwd) === wt)
      .map(s => s.id);
    for (const [sid, binding] of Object.entries(bindings)) {
      if (binding?.workspacePath === wt && !closed.has(sid) && !bound.includes(sid)) bound.push(sid);
    }
    if (bound.some(id => sup.isStreaming(id))) { skipped.push({ branch, reason: "streaming" }); continue; }

    for (const id of bound) {
      await closeSession(sup, hub, id, { removeWorktree: false });
    }
    try {
      ws.removeWorkspace({ repoPath: project.repoPath, workspacePath: wt });
      execFileSync("git", ["branch", "-d", branch], { cwd: project.repoPath }); // safe delete: re-verifies merged
      reaped.push({ branch, sessions: bound });
      hub.emit("system", "branch_reaped", { projectId: project.id, branch, sessions: bound });
    } catch (e) {
      skipped.push({ branch, reason: e.code || String(e.message || e) });
    }
  }
  return { reaped, skipped };
}

export async function sweepAll(sup, hub) {
  const cfg = loadConfig();
  const out = {};
  if (cfg.autoCleanup === false) return out;
  for (const p of cfg.projects) {
    try { out[p.id] = await sweepProject(sup, hub, p, { fetch: cfg.sweepFetch !== false }); }
    catch (e) { out[p.id] = { error: String(e.message || e) }; }
  }
  return out;
}

export function startSweeper(sup, hub) {
  const cfg = loadConfig();
  const minutes = Number(cfg.sweepMinutes ?? 10);
  if (cfg.autoCleanup === false || !(minutes > 0)) return null;
  sweepAll(sup, hub); // once at startup
  const t = setInterval(() => sweepAll(sup, hub), minutes * 60 * 1000);
  t.unref(); // a job in the server, not a reason to stay alive
  return t;
}
