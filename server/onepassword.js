import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";
import { atomicWrite } from "./credential-store.js";

const TOKEN_FILE = path.join("credentials", "onepassword-service-account-token");
const VALIDATION_TIMEOUT_MS = 10_000;

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function credentialPath(home = appHome()) {
  return path.join(home, TOKEN_FILE);
}

export function status(home = appHome()) {
  try {
    const stat = fs.lstatSync(credentialPath(home));
    return { connected: stat.isFile() && stat.size > 0 };
  } catch {
    return { connected: false };
  }
}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("validation_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function validate(token, createClient, timeoutMs) {
  try {
    const factory = createClient || (await import("@1password/sdk")).default.createClient;
    const client = await bounded(factory({
      auth: token,
      integrationName: "pi-ez-web",
      integrationVersion: "1.0.0",
    }), timeoutMs);
    await bounded(client.vaults.list(), timeoutMs);
  } catch {
    throw coded("onepassword_auth_failed", "1Password connection failed.");
  }
}

export async function connect(rawToken, { createClient = null, home = appHome(), timeoutMs = VALIDATION_TIMEOUT_MS } = {}) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token || token.length > 4096) throw coded("onepassword_token_required", "Enter a valid 1Password service-account token.");
  await validate(token, createClient, timeoutMs);
  const directory = path.dirname(credentialPath(home));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  try {
    atomicWrite(credentialPath(home), `${token}\n`);
  } catch {
    throw coded("onepassword_store_failed", "1Password connection could not be stored.");
  }
  return status(home);
}

export function disconnect(home = appHome()) {
  try { fs.rmSync(credentialPath(home), { force: true }); }
  catch { throw coded("onepassword_disconnect_failed", "1Password connection could not be removed."); }
  return status(home);
}
