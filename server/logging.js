import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";
import { redact } from "./redaction.js";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_READ_ENTRIES = 1000;
const MAX_VALUE_LENGTH = 6000;

function filePath() {
  return path.join(appHome(), "logs", "pi-ez-web.log");
}

function safeValue(value) {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return redact(value, { maxLength: MAX_VALUE_LENGTH });
}

export function writeLog(level, message, fields = {}) {
  const entry = {
    at: new Date().toISOString(),
    level: ["error", "warn", "info"].includes(level) ? level : "info",
    message: redact(message, { maxLength: MAX_VALUE_LENGTH }),
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
