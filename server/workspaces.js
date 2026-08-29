// Git context discovery plus the small set of explicit branch operations exposed
// by the web UI. Session state is still path-based; Git is never inferred from a
// stale session branch binding.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { slug } from "./config.js";

export const MAIN_BRANCH = "main";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitLogged(cwd, args, report) {
  const command = `git ${args.join(" ")}`;
  const startedAt = Date.now();
  report?.({ type: "process_start", phase: "git", command, cwd, message: `Running ${command}.` });
  try {
    const stdout = git(cwd, ...args);
    report?.({ type: "process_end", phase: "git", command, cwd, stream: "stdout", output: stdout, exit: 0, durationMs: Date.now() - startedAt, message: `${command} completed.` });
    return stdout;
  } catch (error) {
    const stderr = String(error?.stderr || error?.stdout || error?.message || "").trim();
    report?.({ type: "process_end", phase: "git", command, cwd, stream: "stderr", output: stderr, exit: Number.isFinite(error?.status) ? error.status : 1, durationMs: Date.now() - startedAt, message: `${command} failed.` });
    throw error;
  }
}

export function isGitRepo(dir) {
  try { return git(dir, "rev-parse", "--is-inside-work-tree").trim() === "true"; } catch { return false; }
}

export function currentBranch(dir) {
  try { return git(dir, "symbolic-ref", "--quiet", "--short", "HEAD").trim() || null; } catch { return null; }
}

export function currentHead(dir) {
  try { return git(dir, "rev-parse", "HEAD").trim() || null; } catch { return null; }
}

function gitFailure(code, error, fallback = code) {
  return Object.assign(new Error(code), {
    code,
    detail: String(error?.stderr || error?.stdout || error?.message || fallback).trim().slice(0, 1200),
  });
}

export function validateBranchName(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) {
    throw Object.assign(new Error("bad_branch"), { code: "bad_branch" });
  }
  try { execFileSync("git", ["check-ref-format", "--branch", branch], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { throw gitFailure("bad_branch", error, "Invalid branch name"); }
  return branch;
}

export function defaultBranch(repoPath) {
  const localBranches = listBranches(repoPath);
  const current = currentBranch(repoPath);
  let remoteHead = null;
  try {
    const symbolic = git(repoPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").trim();
    remoteHead = symbolic.replace(/^origin\//, "") || null;
  } catch { /* origin/HEAD is optional */ }
  const candidates = [remoteHead, current === "main" || current === "master" ? current : null, "main", "master", current];
  return candidates.find(branch => branch && localBranches.includes(branch)) || current || MAIN_BRANCH;
}

export function branchUpstream(repoPath, branch = null) {
  branch ||= defaultBranch(repoPath);
  try {
    return git(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`).trim() || null;
  } catch { return null; }
}

export function mainExternalWorktree(repoPath, primaryBranch = defaultBranch(repoPath)) {
  return listContexts(repoPath).find(context => context.branch === primaryBranch && context.kind === "worktree") || null;
}

// Put the primary checkout on the repository's default branch and, when it has
// an upstream, fast-forward it after fetching. Callers use this at
// branch-creation and merge boundaries, never as an implicit session-open side
// effect.
function runGitProcess(cwd, args, report) {
  return new Promise((resolve, reject) => {
    const command = `git ${args.join(" ")}`;
    const startedAt = Date.now();
    report?.({ type: "process_start", phase: "git", command, cwd, message: `Running ${command}.` });
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      const value = String(chunk);
      stdout += value;
      report?.({ type: "process_output", phase: "git", command, cwd, stream: "stdout", output: value });
    });
    child.stderr.on("data", chunk => {
      const value = String(chunk);
      stderr += value;
      report?.({ type: "process_output", phase: "git", command, cwd, stream: "stderr", output: value });
    });
    child.on("error", error => {
      report?.({ type: "process_end", phase: "git", command, cwd, stream: "stderr", output: stderr || error.message, exit: 1, durationMs: Date.now() - startedAt, message: `${command} failed.` });
      reject(Object.assign(error, { stderr, stdout, status: 1 }));
    });
    child.on("close", code => {
      const exit = typeof code === "number" ? code : 1;
      report?.({ type: "process_end", phase: "git", command, cwd, stream: exit === 0 ? "stdout" : "stderr", output: exit === 0 ? stdout : stderr || stdout, exit, durationMs: Date.now() - startedAt, message: exit === 0 ? `${command} completed.` : `${command} failed.` });
      if (exit === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${command} failed`), { stderr, stdout, status: exit }));
    });
  });
}

export async function fetchRepositoryAsync(repoPath, { report = null } = {}) {
  const args = ["fetch", "--all", "--prune"];
  try {
    const stdout = await runGitProcess(repoPath, args, report);
    return { command: `git ${args.join(" ")}`, stdout, stderr: "", fetched: true };
  } catch (error) {
    throw gitFailure("git_fetch_failed", error, "Git fetch failed");
  }
}

export function prepareMain(repoPath, { fetch = true, primaryBranch = null, report = null } = {}) {
  primaryBranch ||= defaultBranch(repoPath);
  const external = mainExternalWorktree(repoPath, primaryBranch);
  if (external) throw Object.assign(new Error("main_worktree_external"), { code: "main_worktree_external", workspacePath: external.path });
  const branch = currentBranch(repoPath);
  if (branch !== primaryBranch) {
    assertCleanCheckout(repoPath);
    try { gitLogged(repoPath, ["switch", primaryBranch], report); }
    catch (error) { throw gitFailure("git_switch_failed", error); }
  }
  const upstream = branchUpstream(repoPath, primaryBranch);
  if (!upstream || !fetch) return { branch: primaryBranch, upstream, fetched: false, fastForwarded: false };
  assertCleanCheckout(repoPath);
  const remote = upstream.split("/")[0];
  try {
    gitLogged(repoPath, ["fetch", "--prune", remote], report);
  } catch (error) { throw gitFailure("main_fetch_failed", error); }
  try {
    const before = currentHead(repoPath);
    gitLogged(repoPath, ["merge", "--ff-only", upstream], report);
    return { branch: primaryBranch, upstream, fetched: true, fastForwarded: before !== currentHead(repoPath) };
  } catch (error) { throw gitFailure("main_not_fast_forwardable", error); }
}

function refHead(workspacePath, ref) {
  try { return git(workspacePath, "rev-parse", "--verify", ref).trim() || null; } catch { return null; }
}

export function pushPreview(workspacePath, { limit = 100 } = {}) {
  const branch = currentBranch(workspacePath);
  if (!branch) throw Object.assign(new Error("detached_head"), { code: "detached_head" });
  const configuredUpstream = branchUpstream(workspacePath, branch);
  const upstream = configuredUpstream || `origin/${branch}`;
  const remote = upstream.split("/", 1)[0];
  const baseRef = [
    configuredUpstream,
    remoteBranchForLocal(workspacePath, branch),
    `${remote}/${defaultBranch(workspacePath)}`,
  ].find(ref => ref && refHead(workspacePath, ref));
  const head = refHead(workspacePath, "HEAD");
  if (!head) throw Object.assign(new Error("push_preview_failed"), { code: "push_preview_failed" });
  const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
  try {
    const commitCount = Number(git(workspacePath, "rev-list", "--count", range).trim()) || 0;
    const commits = commitCount
      ? git(workspacePath, "log", "--no-decorate", `--format=%H%x00%h%x00%s`, "-n", String(Math.max(1, limit)), range)
        .split("\n").filter(Boolean).map(line => {
          const [hash, shortHash, ...subject] = line.split("\0");
          return { hash, shortHash, subject: subject.join("\0") };
        })
      : [];
    return { branch, upstream, remote, head, baseRef, baseHead: baseRef ? refHead(workspacePath, baseRef) : null, commitCount, commits, dirty: isDirty(workspacePath) };
  } catch (error) { throw gitFailure("push_preview_failed", error); }
}

export function pushWorkspace(workspacePath, { report = null } = {}) {
  const branch = currentBranch(workspacePath);
  if (!branch) throw Object.assign(new Error("detached_head"), { code: "detached_head" });
  try {
    const upstream = branchUpstream(workspacePath, branch);
    const args = upstream ? ["push"] : ["push", "-u", "origin", branch];
    return { branch, upstream: upstream || `origin/${branch}`, command: `git ${args.join(" ")}`, stdout: gitLogged(workspacePath, args, report), stderr: "" };
  } catch (error) { throw gitFailure("git_push_failed", error); }
}

export function mergeBranch(repoPath, branch, { report = null } = {}) {
  validateBranchName(branch);
  try {
    return gitLogged(repoPath, ["merge", "--no-ff", "--no-edit", branch], report);
  } catch (error) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* no merge to abort */ }
    throw gitFailure("merge_conflict", error);
  }
}

export function deleteLocalBranch(repoPath, branch, primaryBranch = defaultBranch(repoPath)) {
  validateBranchName(branch);
  if (branch === primaryBranch) throw Object.assign(new Error("cannot_delete_main"), { code: "cannot_delete_main" });
  try { return execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { throw gitFailure("branch_delete_failed", error); }
}

export async function prepareMainAsync(repoPath, { fetch = true, primaryBranch = null, report = null } = {}) {
  primaryBranch ||= defaultBranch(repoPath);
  const external = mainExternalWorktree(repoPath, primaryBranch);
  if (external) throw Object.assign(new Error("main_worktree_external"), { code: "main_worktree_external", workspacePath: external.path });
  const branch = currentBranch(repoPath);
  if (branch !== primaryBranch) {
    assertCleanCheckout(repoPath);
    try { await runGitProcess(repoPath, ["switch", primaryBranch], report); }
    catch (error) { throw gitFailure("git_switch_failed", error); }
  }
  const upstream = branchUpstream(repoPath, primaryBranch);
  if (!upstream || !fetch) return { branch: primaryBranch, upstream, fetched: false, fastForwarded: false };
  assertCleanCheckout(repoPath);
  const remote = upstream.split("/")[0];
  try { await runGitProcess(repoPath, ["fetch", "--prune", remote], report); }
  catch (error) { throw gitFailure("main_fetch_failed", error); }
  try {
    const before = currentHead(repoPath);
    await runGitProcess(repoPath, ["merge", "--ff-only", upstream], report);
    return { branch: primaryBranch, upstream, fetched: true, fastForwarded: before !== currentHead(repoPath) };
  } catch (error) { throw gitFailure("main_not_fast_forwardable", error); }
}

export function isDirty(dir) {
  try { return git(dir, "status", "--porcelain").trim().length > 0; } catch { return false; }
}

function dirtyState(dir) {
  try {
    return { dirty: git(dir, "status", "--porcelain").trim().length > 0, error: null };
  } catch (error) {
    return { dirty: null, error: String(error?.stderr || error?.message || "Git status unavailable").trim().slice(0, 400) };
  }
}

function assertCleanCheckout(repoPath) {
  const status = dirtyState(repoPath);
  if (status.dirty == null) throw Object.assign(new Error("git_status_unavailable"), { code: "git_status_unavailable", detail: status.error });
  if (status.dirty) throw Object.assign(new Error("checkout_dirty"), { code: "checkout_dirty" });
}

export function workspaceStatus({ repoPath, branch, workspacePath, primaryBranch = defaultBranch(repoPath) }) {
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
  const kind = path.resolve(workspacePath) === path.resolve(repoPath) ? "checkout" : "worktree";
  branch ||= currentBranch(workspacePath);
  const externalMain = branch === primaryBranch && kind === "worktree";
  const state = dirtyState(workspacePath);
  return {
    branch: branch || null,
    path: workspacePath,
    kind,
    dirty: state.dirty,
    upstream,
    ahead,
    behind,
    externalMain,
    protected: externalMain,
  };
}

export function contextId(repoPath, workspacePath) {
  const key = `${path.resolve(repoPath)}\0${path.resolve(workspacePath)}`;
  return `ctx_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

export function listWorktreeRecords(repoPath) {
  const out = git(repoPath, "worktree", "list", "--porcelain");
  const records = [];
  let record = null;
  const finish = () => {
    if (!record) return;
    record.path = logicalWorktreePath(repoPath, record.path);
    records.push(record);
    record = null;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      finish();
      record = { path: line.slice(9).trim(), head: null, branch: null, detached: false };
    } else if (!record) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      record.head = line.slice(5).trim() || null;
    } else if (line.startsWith("branch ")) {
      record.branch = line.slice(7).trim().replace(/^refs\/heads\//, "") || null;
    } else if (line === "detached") {
      record.detached = true;
    }
  }
  finish();
  return records;
}

export function contextStatus({ repoPath, workspacePath, record = null, primaryBranch = defaultBranch(repoPath) }) {
  const status = workspaceStatus({
    repoPath,
    workspacePath,
    branch: currentBranch(workspacePath) || record?.branch || null,
    primaryBranch,
  });
  return {
    ...status,
    id: contextId(repoPath, workspacePath),
    head: currentHead(workspacePath) || record?.head || null,
    detached: !status.branch,
    primaryBranch,
    status: status.dirty == null ? "unknown" : status.dirty ? "dirty" : "clean",
    statusError: dirtyState(workspacePath).error,
  };
}

export function listContexts(repoPath) {
  return listWorktreeRecords(repoPath).map(record => contextStatus({
    repoPath,
    workspacePath: record.path,
    record,
  }));
}

export function resolveContext(repoPath, id) {
  const context = listContexts(repoPath).find(item => item.id === String(id || ""));
  if (!context) throw Object.assign(new Error("no_such_context"), { code: "no_such_context" });
  return context;
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

export function switchWorkspace({ repoPath, workspacePath, branch, fromRef = null, primaryBranch = defaultBranch(repoPath) }) {
  if (branch === primaryBranch && path.resolve(workspacePath) !== path.resolve(repoPath)) {
    throw Object.assign(new Error("main_worktree_forbidden"), { code: "main_worktree_forbidden" });
  }
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

// Legacy branch -> path discovery. New UI code should use listContexts(),
// because detached worktrees and branch changes need a stable path identity.
export function listWorktrees(repoPath) {
  const map = {};
  for (const context of listContexts(repoPath)) {
    if (context.branch) map[context.branch] = context.path;
  }
  return map;
}

export function prune(repoPath) {
  try { git(repoPath, "worktree", "prune"); } catch { /* non-fatal */ }
}

function worktreePathFor(root, projectId, branch) {
  const base = path.join(root, projectId, slug(branch).replace(/\//g, "__"));
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// Ensure a workspace (worktree) exists for `branch`; create a new branch from
// `fromRef` when it does not exist. The main branch remains checkout-only.
// Existing branch-only checkouts are observed and reused rather than moved.
export function ensureWorkspace({ repoPath, worktreeRoot, projectId, branch, fromRef, primaryBranch = defaultBranch(repoPath), report = null }) {
  branch = validateBranchName(branch);
  if (branch === primaryBranch) {
    throw Object.assign(new Error("main_worktree_forbidden"), { code: "main_worktree_forbidden" });
  }
  const existing = listWorktrees(repoPath);
  if (existing[branch]) return existing[branch];
  const wt = worktreePathFor(worktreeRoot, projectId, branch);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branches = listBranches(repoPath);
  if (branches.includes(branch)) {
    gitLogged(repoPath, ["worktree", "add", wt, branch], report);
  } else {
    gitLogged(repoPath, ["worktree", "add", "-b", branch, wt, fromRef || "HEAD"], report);
  }
  return wt;
}

export function removeWorkspace({ repoPath, workspacePath, force = false, primaryBranch = defaultBranch(repoPath) }) {
  const branch = currentBranch(workspacePath);
  if (branch === primaryBranch && path.resolve(workspacePath) !== path.resolve(repoPath)) {
    throw Object.assign(new Error("main_worktree_external"), { code: "main_worktree_external" });
  }
  if (!force && isDirty(workspacePath)) {
    const err = new Error("workspace_dirty");
    err.code = "workspace_dirty";
    throw err;
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  git(repoPath, ...args, workspacePath.replace(/\/$/, ""));
}

// Legacy Git-mutating fork helper. Conversation forks now select an existing
// context and never transfer working-tree state.
// Fork: new branch + worktree from the parent workspace's HEAD. Dirty state
// may be transferred from an app-owned worktree, but the user's checkout is
// sacred and is rejected before any stash mutation.
export function forkWorkspace({ repoPath, worktreeRoot, projectId, parentWorkspace, parentBranch, existingBranches, forkBranchBase, branch: requestedBranch, primaryBranch = defaultBranch(repoPath) }) {
  const stem = parentBranch.replace(/^(feat|spike|fix|branch)\//, "");
  let n = 1, branch = String(requestedBranch || "").trim();
  if (branch) {
    if (branch === primaryBranch) throw Object.assign(new Error("main_worktree_forbidden"), { code: "main_worktree_forbidden" });
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
