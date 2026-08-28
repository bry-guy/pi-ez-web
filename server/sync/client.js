import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MODULE = "@bry-guy/pi-sync";

const modulePromises = new Map();

export function syncClientModuleName() {
  return process.env.PI_WEB_SYNC_CLIENT_MODULE || DEFAULT_MODULE;
}

export async function loadPiSyncModule() {
  const specifier = importSpecifier();
  if (!modulePromises.has(specifier)) {
    modulePromises.set(specifier, import(specifier).catch(error => {
      modulePromises.delete(specifier);
      throw Object.assign(new Error("The pi-sync client is not installed."), {
        code: "sync_client_unavailable",
        cause: error,
      });
    }));
  }
  return modulePromises.get(specifier);
}

export async function createSyncClient(baseUrl, options = {}) {
  const module = options.module || await loadPiSyncModule();
  if (typeof module.SyncClient !== "function") {
    throw Object.assign(new Error("The installed pi-sync package does not expose SyncClient."), {
      code: "sync_client_unavailable",
    });
  }
  return new module.SyncClient({ baseUrl, timeoutMs: options.timeoutMs ?? 8_000, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

export async function syncSkillPath() {
  const resolved = await import.meta.resolve(importSpecifier());
  const file = fileURLToPath(resolved);
  return path.resolve(path.dirname(file), "../../skills");
}

export async function syncExtensionPath() {
  const resolved = await import.meta.resolve(importSpecifier());
  const file = fileURLToPath(resolved);
  const root = path.resolve(path.dirname(file), "../..");
  const candidates = [
    path.join(root, "dist", "extensions", "sync.js"),
    path.join(root, "extensions", "sync.js"),
    path.join(root, "extensions", "sync.ts"),
  ];
  const extension = candidates.find(candidate => fs.existsSync(candidate));
  if (!extension) {
    throw Object.assign(new Error("The installed pi-sync package does not expose its Pi extension."), {
      code: "sync_client_unavailable",
    });
  }
  return extension;
}

function importSpecifier() {
  const raw = syncClientModuleName();
  let filePath = raw;
  try {
    if (raw.startsWith("file:")) filePath = fileURLToPath(raw);
    if (path.isAbsolute(filePath) && fs.existsSync(path.join(filePath, "package.json"))) {
      return pathToFileURL(path.join(filePath, "dist/src/index.js")).href;
    }
  } catch {
    // Let the normal dynamic import produce the stable unavailable error.
  }
  return raw;
}

export function clientErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "sync_unavailable";
}

export function clientErrorMessage(error, fallback = "The synchronization service is unavailable.") {
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  return fallback;
}

export function isTransportError(error) {
  return ["network_error", "timeout", "aborted"].includes(error?.code);
}
