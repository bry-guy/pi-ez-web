import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

const MAX_OUTPUT = 16_000;

// Keyed by workspace path under the app state dir: resetting that state discards the log with it.
const fileFor = workspace => path.join(appHome(), "workspace-history", `${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}.jsonl`);

// Append-only: one JSON line per finished operation (hook, git operation, fork or switch).
export function appendHistory(workspace, entry) {
  const file = fileFor(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ...entry, output: String(entry.output || "").slice(-MAX_OUTPUT) });
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

// Newest first. A torn final line (crash mid-write) is skipped, not fatal.
export function readHistory(workspace, limit = 200) {
  let text;
  try { text = fs.readFileSync(fileFor(workspace), "utf8"); } catch { return []; }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return entries.slice(-limit).reverse();
}
