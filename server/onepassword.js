import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";
import { atomicWrite } from "./credential-store.js";

const TOKEN_FILE = path.join("credentials", "onepassword-service-account-token");
const VALIDATION_TIMEOUT_MS = 10_000;

function coded(code, message = code, stage = null) {
  return Object.assign(new Error(message), { code, ...(stage ? { onepasswordStage: stage } : {}) });
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

export function executionEnvironment(source = process.env, home = appHome()) {
  const env = { ...source };
  delete env.OP_SERVICE_ACCOUNT_TOKEN;
  delete env.PI_WEB_ONEPASSWORD_TOKEN_FILE;
  if (status(home).connected) env.PI_WEB_ONEPASSWORD_TOKEN_FILE = credentialPath(home);
  return env;
}

const RATE_LIMIT_ERROR_NAMES = new Set(["RateLimitExceededError"]);
const NETWORK_ERROR_CODES = new Set(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const SDK_RUNTIME_ERROR_CODES = new Set(["ERR_DLOPEN_FAILED", "ERR_WASM_COMPILE_ERROR", "ERR_WASM_LINK_ERROR", "ERR_WASM_RUNTIME_ERROR"]);

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(coded("onepassword_validation_timeout", "1Password validation timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sdkFactory(createClient, loadSdk) {
  if (createClient !== null) {
    if (typeof createClient === "function") return createClient;
    throw coded("onepassword_sdk_unavailable", "1Password SDK is unavailable on this server.", "sdk_load");
  }
  let sdk;
  try {
    sdk = await (loadSdk || (() => import("@1password/sdk")))();
    const factory = [sdk?.createClient, sdk?.default?.createClient].find(value => typeof value === "function");
    if (factory) return factory;
  } catch {}
  throw coded("onepassword_sdk_unavailable", "1Password SDK is unavailable on this server.", "sdk_load");
}

function errorName(error) {
  return error?.constructor?.name || error?.name || "";
}

function validationFailure(error, stage) {
  const cause = error?.cause;
  const codes = [error?.code, cause?.code];
  const names = [error?.name, errorName(error), cause?.name, errorName(cause)];
  const messages = [error?.message, cause?.message].filter(Boolean).join(" ");
  if (error?.code === "onepassword_validation_timeout") return coded("onepassword_validation_timeout", "1Password validation timed out.", stage);
  if (error?.code === "onepassword_sdk_unavailable") return coded("onepassword_sdk_unavailable", "1Password SDK is unavailable on this server.", stage);
  if ([error?.status, error?.statusCode, cause?.status, cause?.statusCode].includes(429)
    || codes.includes(429)
    || names.some(name => RATE_LIMIT_ERROR_NAMES.has(name))) {
    return coded("onepassword_rate_limited", "1Password is rate limited. Try again later.", stage);
  }
  if (codes.some(code => NETWORK_ERROR_CODES.has(code))
    || (names.includes("TypeError") && /fetch failed|network/i.test(messages))) {
    return coded("onepassword_service_unavailable", "1Password service is unavailable. Try again later.", stage);
  }
  if (codes.some(code => SDK_RUNTIME_ERROR_CODES.has(code))
    || names.some(name => ["RuntimeError", "CompileError", "LinkError"].includes(name))) {
    return coded("onepassword_sdk_unavailable", "1Password SDK is unavailable on this server.", stage);
  }
  return coded("onepassword_auth_failed", "1Password authentication failed.", stage);
}

async function validate(token, createClient, loadSdk, timeoutMs) {
  const factory = await sdkFactory(createClient, loadSdk);
  let client;
  try {
    client = await bounded(factory({
      auth: token,
      integrationName: "pi-ez-web",
      integrationVersion: "1.0.0",
    }), timeoutMs);
    if (typeof client?.vaults?.list !== "function") throw coded("onepassword_sdk_unavailable", "1Password SDK is unavailable on this server.", "client_create");
  } catch (error) {
    throw validationFailure(error, "client_create");
  }
  try {
    await bounded(client.vaults.list(), timeoutMs);
  } catch (error) {
    throw validationFailure(error, "vault_list");
  }
}

export async function connect(rawToken, { createClient = null, loadSdk = null, writeCredential = atomicWrite, home = appHome(), timeoutMs = VALIDATION_TIMEOUT_MS } = {}) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token || token.length > 4096) throw coded("onepassword_token_required", "Enter a valid 1Password service-account token.", "input");
  await validate(token, createClient, loadSdk, timeoutMs);
  try {
    const directory = path.dirname(credentialPath(home));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch {}
    writeCredential(credentialPath(home), `${token}\n`);
  } catch {
    throw coded("onepassword_store_failed", "1Password connection could not be stored.", "credential_store");
  }
  return status(home);
}

export function disconnect(home = appHome()) {
  try { fs.rmSync(credentialPath(home), { force: true }); }
  catch { throw coded("onepassword_disconnect_failed", "1Password connection could not be removed."); }
  return status(home);
}
