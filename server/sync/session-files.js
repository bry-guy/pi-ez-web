import { loadPiSyncModule } from "./client.js";

export async function normalizeSessionFile(file, options = {}) {
  const module = await loadPiSyncModule();
  if (typeof module.normalizeSessionFile !== "function") {
    throw Object.assign(new Error("The installed pi-sync package does not expose the session adapter."), { code: "sync_client_unavailable" });
  }
  return module.normalizeSessionFile(file, options);
}

export async function deriveWorkspacePointer(cwd, runner) {
  const module = await loadPiSyncModule();
  if (typeof module.deriveWorkspacePointer !== "function") return undefined;
  const pointer = await module.deriveWorkspacePointer(cwd, runner);
  if (!pointer) return undefined;
  const gitRemote = sanitizeGitRemote(pointer.gitRemote);
  return gitRemote ? { ...pointer, gitRemote } : undefined;
}

export async function materializeSessionFile(file, envelope, options) {
  const module = await loadPiSyncModule();
  if (typeof module.materializeSessionFile !== "function") {
    throw Object.assign(new Error("The installed pi-sync package does not expose session materialization."), { code: "sync_client_unavailable" });
  }
  return module.materializeSessionFile(file, envelope, options);
}

export async function restoreHead(session, headEntryId) {
  if (!headEntryId) return;
  const module = await loadPiSyncModule();
  if (typeof module.restoreHead === "function") {
    return module.restoreHead((entryId, options) => session.navigateTree(entryId, options), headEntryId);
  }
  const result = await session.navigateTree(headEntryId, { summarize: false });
  if (result?.cancelled) throw new Error("Pi cancelled head restoration");
}

export function stableEnvelopeFingerprint(envelope) {
  return JSON.stringify(envelope);
}

function sanitizeGitRemote(value) {
  const remote = String(value || "").trim();
  if (!remote || /[\u0000\r\n]/.test(remote)) return undefined;
  // Strip URL userinfo. Git remotes can contain an access token in the
  // password slot; that must never enter the synchronized envelope.
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "") || undefined;
  } catch {
    // SCP-style SSH remotes such as git@github.com:owner/repo.git have no
    // password field. Preserve them while rejecting whitespace/control data.
    return /\s/.test(remote) ? undefined : remote;
  }
}

