// Git workspace operations. Invariants:
// - Workspace = worktree, one per branch (git enforces one checkout per branch).
// - Git mutations are explicit: Switch changes the current workspace branch;
//   Worktree and Fork add worktrees under worktreeRoot.
// - Fork carries dirty state via stash transfer (stashes share the object store).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { slug } from "./config.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function isGitRepo(dir) {
  try { return git(dir, "rev-parse", "--is-inside-work-tree").trim() === "true"; } catch { return false; }
}

export function currentBranch(dir) {
  try { return git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { return null; }
}

export function isDirty(dir) {
  try { return git(dir, "status", "--porcelain").trim().length > 0; } catch { return false; }
}

export function workspaceStatus({ repoPath, branch, workspacePath }) {
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  try {
    upstream = git(workspacePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").trim() || null;
    if (upstream) {
      const counts = git(workspacePath, "rev-list", "--left-right", "--count", "@{upstream}...HEAD").trim().split(/\s+/).map(Number);
      behind = Number.isFinite(counts[0]) ? counts[0] : 0;
      ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
    }
  } catch { /* a branch without an upstream has no ahead/behind counts */ }
  return {
    branch,
    path: workspacePath,
    kind: path.resolve(workspacePath) === path.resolve(repoPath) ? "checkout" : "worktree",
    dirty: isDirty(workspacePath),
    upstream,
    ahead,
    behind,
  };
}

export function pullWorkspace(workspacePath) {
  try {
    return {
      stdout: execFileSync("git", ["pull", "--ff-only"], { cwd: workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      stderr: "",
    };
  } catch (error) {
    throw Object.assign(new Error("git_pull_failed"), {
      code: "git_pull_failed",
      detail: String(error.stderr || error.stdout || error.message || "git pull failed").trim().slice(0, 1000),
    });
  }
}

export function switchWorkspace({ workspacePath, branch, fromRef = null }) {
  const args = ["switch"];
  if (fromRef) args.push("-c", branch, fromRef);
  else args.push(branch);
  try {
    return {
      stdout: execFileSync("git", args, { cwd: workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      stderr: "",
    };
  } catch (error) {
    throw Object.assign(new Error("git_switch_failed"), {
      code: "git_switch_failed",
      detail: String(error.stderr || error.stdout || error.message || "git switch failed").trim().slice(0, 1000),
    });
  }
}

export function listBranches(repoPath) {
  try {
    return git(repoPath, "branch", "--format=%(refname:short)").split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function listRemoteBranches(repoPath) {
  try {
    return git(repoPath, "branch", "--remotes", "--format=%(refname:short)")
      .split("\n")
      .map(s => s.trim())
      .filter(branch => branch && !branch.endsWith("/HEAD"));
  } catch { return []; }
}

export function localBranchForRemote(remoteBranch) {
  const value = String(remoteBranch || "").trim();
  const slash = value.indexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function remoteBranchForLocal(repoPath, branch) {
  const local = String(branch || "").trim();
  if (!local) return null;
  return listRemoteBranches(repoPath).find(remote => localBranchForRemote(remote) === local) || null;
}

// Git reports canonical paths on macOS (for example /private/var/... even when
// the caller used /var/...). Keep the path spelling supplied by the caller so
// configured project paths, session cwd values, and discovered worktrees still
// compare equal across platforms.
function logicalWorktreePath(repoPath, discoveredPath) {
  const logicalRepo = path.resolve(repoPath);
  try {
    // On macOS /var is a symlink to /private/var. Git reports the real spelling
    // even for worktrees outside the repository, so find the highest aliased
    // ancestor and translate any discovered path beneath it back to the user's
    // logical spelling.
    let logicalAlias = null;
    let realAlias = null;
    for (let current = logicalRepo; ; current = path.dirname(current)) {
      const real = fs.realpathSync(current);
      if (real !== current) { logicalAlias = current; realAlias = real; }
      const parent = path.dirname(current);
      if (parent === current) break;
    }
    if (!logicalAlias) return discoveredPath;
    const realPath = fs.realpathSync(discoveredPath);
    const relative = path.relative(realAlias, realPath);
    if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
      return path.join(logicalAlias, relative);
    }
  } catch { /* keep Git's path when it cannot be resolved */ }
  return discoveredPath;
}

// Live discovery, pi-web style: { branch -> worktreePath } incl. the checkout itself.
export function listWorktrees(repoPath) {
  const out = git(repoPath, "worktree", "list", "--porcelain");
  const map = {};
  let wt = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) wt = line.slice(9).trim();
    else if (line.startsWith("branch ") && wt) {
      map[line.slice(7).trim().replace(/^refs\/heads\//, "")] = logicalWorktreePath(repoPath, wt);
      wt = null;
    } else if (line === "detached") wt = null;
  }
  return map;
}

export function prune(repoPath) {
  try { git(repoPath, "worktree", "prune"); } catch { /* non-fatal */ }
}

function worktreePathFor(root, projectId, branch) {
  return path.join(root, projectId, slug(branch).replace(/\//g, "__"));
}

// Ensure a workspace (worktree) exists for `branch`; create branch from
// `fromRef` (default: repo HEAD) if it doesn't exist. Returns its path.
// Never touches the user's checkout: if the branch is checked out there,
// that IS the workspace.
export function ensureWorkspace({ repoPath, worktreeRoot, projectId, branch, fromRef }) {
  const existing = listWorktrees(repoPath);
  if (existing[branch]) return existing[branch];
  const wt = worktreePathFor(worktreeRoot, projectId, branch);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branches = listBranches(repoPath);
  if (branches.includes(branch)) {
    git(repoPath, "worktree", "add", wt, branch);
  } else {
    git(repoPath, "worktree", "add", "-b", branch, wt, fromRef || "HEAD");
  }
  return wt;
}

export function removeWorkspace({ repoPath, workspacePath, force = false }) {
  if (!force && isDirty(workspacePath)) {
    const err = new Error("workspace_dirty");
    err.code = "workspace_dirty";
    throw err;
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  git(repoPath, ...args, workspacePath.replace(/\/$/, ""));
}

// Fork: new branch + worktree from the parent workspace's HEAD. Dirty state
// may be transferred from an app-owned worktree, but the user's checkout is
// sacred and is rejected before any stash mutation.
export function forkWorkspace({ repoPath, worktreeRoot, projectId, parentWorkspace, parentBranch, existingBranches, forkBranchBase, branch: requestedBranch }) {
  const stem = parentBranch.replace(/^(feat|spike|fix|branch)\//, "");
  let n = 1, branch = String(requestedBranch || "").trim();
  if (branch) {
    if (existingBranches.includes(branch)) throw Object.assign(new Error("branch_exists"), { code: "branch_exists" });
  } else if (forkBranchBase) {
    do { branch = `${forkBranchBase}.${n++}`; } while (existingBranches.includes(branch));
  } else {
    do { branch = `branch/${stem}-${n++}`; } while (existingBranches.includes(branch));
  }

  const dirty = isDirty(parentWorkspace);
  const isCheckout = path.resolve(parentWorkspace) === path.resolve(repoPath);
  if (dirty && isCheckout) throw Object.assign(new Error("checkout_dirty"), { code: "checkout_dirty" });

  let stashRef = null;
  if (dirty) {
    const marker = `pi-web-ui fork transfer ${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    git(parentWorkspace, "stash", "push", "-u", "-m", marker);
    stashRef = git(parentWorkspace, "rev-parse", "refs/stash").trim();
  }
  try {
    const parentHead = git(parentWorkspace, "rev-parse", "HEAD").trim();
    const wt = worktreePathFor(worktreeRoot, projectId, branch);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoPath, "worktree", "add", "-b", branch, wt, parentHead);
    if (stashRef) git(wt, "stash", "apply", stashRef);
    return { branch, workspacePath: wt };
  } finally {
    if (stashRef) {
      // Restore the exact stash object to the parent, then drop only that
      // object. This avoids assuming another stash has not been created.
      try { git(parentWorkspace, "stash", "apply", stashRef); }
      finally { try { git(parentWorkspace, "stash", "drop", stashRef); } catch { /* surface via diagnostics */ } }
    }
  }
}

// Startup diagnostics can surface app-owned transfer stashes left behind by a
// crash. The caller decides where to present the warning.
export function piWebStashes(repoPath) {
  try {
    return git(repoPath, "stash", "list", "--format=%H%x09%s")
      .split("\n").map(s => s.trim()).filter(Boolean)
      .filter(s => s.includes("\tpi-web-ui fork transfer "));
  } catch { return []; }
}

// Repo picker: shallow scan for git repos under a root dir.
export function findRepos(root, depth = 2) {
  const out = [];
  const walk = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === ".git")) { out.push(dir); return; }
    if (d >= depth) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), d + 1);
    }
  };
  walk(root, 0);
  return out;
}

// File tree for the panel: directories-first, alphabetical, with stable
// relative paths for file selection. Git metadata and dependency trees stay
// hidden; repository dotfiles remain visible because this is a full explorer.
export function fileTree(dir) {
  const walk = (d, prefix = "") => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => (e.isDirectory() || e.isFile()) && e.name !== ".git" && e.name !== "node_modules")
      .map(e => {
        const relative = prefix ? `${prefix}/${e.name}` : e.name;
        return e.isDirectory()
          ? { n: e.name, p: relative, c: walk(path.join(d, e.name), relative) }
          : { n: e.name, p: relative };
      })
      .sort((a, b) => (!!b.c - !!a.c) || a.n.localeCompare(b.n));
  };
  return walk(dir);
}
