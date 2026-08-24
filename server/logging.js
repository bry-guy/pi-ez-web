import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_READ_ENTRIES = 1000;
const MAX_VALUE_LENGTH = 6000;

function redact(value) {
  let result = String(value ?? "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
  for (const secret of [process.env.OP_SERVICE_ACCOUNT_TOKEN, process.env.PI_WEB_GITHUB_TOKEN]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result.slice(0, MAX_VALUE_LENGTH);
}

function filePath() {
  return path.join(appHome(), "logs", "pi-ez-web.log");
}

function safeValue(value) {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return redact(value);
}

export function writeLog(level, message, fields = {}) {
  const entry = {
    at: new Date().toISOString(),
    level: ["error", "warn", "info"].includes(level) ? level : "info",
    message: redact(message),
  };
  for (const [key, value] of Object.entries(fields)) {
    const safe = safeValue(value);
    if (safe !== undefined) entry[key] = safe;
  }
  try {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(target).size > MAX_LOG_BYTES) fs.renameSync(target, `${target}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") return entry;
    }
    fs.appendFileSync(target, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch { /* diagnostics must never break the request they describe */ }
  return entry;
}

export function readLogs(limit = MAX_READ_ENTRIES) {
  const count = Math.min(MAX_READ_ENTRIES, Math.max(1, Number(limit) || 200));
  let lines;
  try { lines = fs.readFileSync(filePath(), "utf8").split("\n").filter(Boolean).slice(-count); }
  catch (error) { return error.code === "ENOENT" ? [] : [{ at: new Date().toISOString(), level: "error", message: `Could not read the server log: ${error.message}` }]; }
  return lines.flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [{ at: new Date().toISOString(), level: "warn", message: "The server log contains an unreadable entry." }];
    }
  });
}

export function logFileName() {
  return "logs/pi-ez-web.log";
}
