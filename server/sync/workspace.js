import { execFileSync } from "node:child_process";

/**
 * Verify that the current web workspace can safely host a canonical snapshot.
 * This is intentionally read-only: synchronization never fetches, switches
 * branches, or transfers local worktree state on the user's behalf.
 */
export function verifyWorkspacePointer(pointer, cwd) {
  if (!pointer) return;
  if (!cwd) throw workspaceError("A synchronized workspace is required for this conversation.");
  if (!/^[0-9a-f]{7,128}$/i.test(String(pointer.commit || ""))) throw workspaceError("The synchronized Git commit is invalid.");
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch !== pointer.branch) {
    throw workspaceError(`Select branch ${pointer.branch} before continuing this synchronized conversation.`);
  }

  const remotes = (runGit(cwd, ["remote"]) || "").split("\n").map(value => value.trim()).filter(Boolean);
  const expected = normalizeRemote(pointer.gitRemote);
  const hasRemote = remotes.some(remote => normalizeRemote(runGit(cwd, ["remote", "get-url", remote])) === expected);
  if (!hasRemote) throw workspaceError("The synchronized conversation belongs to a different Git upstream.");

  if (!gitSucceeds(cwd, ["cat-file", "-e", `${pointer.commit}^{commit}`])) {
    throw workspaceError(`Fetch commit ${pointer.commit} through the normal Git workflow before continuing.`);
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", pointer.commit, "HEAD"], { cwd, stdio: "ignore" });
  } catch {
    throw workspaceError(`Update this workspace through the normal Git workflow until it contains ${pointer.commit}.`);
  }
}

function runGit(cwd, args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

function gitSucceeds(cwd, args) {
  try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; }
  catch { return false; }
}

function normalizeRemote(value) {
  const remote = String(value || "").trim();
  try {
    const parsed = new URL(remote);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/$/, "").replace(/\.git$/, "");
  } catch {
    const scp = remote.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\/$/, "").replace(/\.git$/, "");
    return remote.replace(/\.git$/, "").replace(/\/$/, "");
  }
}

function workspaceError(message) {
  return Object.assign(new Error(message), { code: "sync_workspace_setup_required" });
}
