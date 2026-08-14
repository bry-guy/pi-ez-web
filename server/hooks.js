import { spawn } from "node:child_process";
import { normalizeHookSets, normalizeHooks } from "./config.js";

function redacted(value) {
  let text = String(value ?? "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
  for (const secret of [process.env.OP_SERVICE_ACCOUNT_TOKEN, process.env.PI_WEB_GITHUB_TOKEN]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

export function projectHooks(cfg, project) {
  const named = project?.name ? normalizeHookSets(cfg.projectHookSets)[project.name] : null;
  return {
    ...normalizeHooks(cfg.projectHooks),
    ...normalizeHooks(named),
    ...(project?.setup ? { setup: project.setup } : {}),
    ...normalizeHooks(project?.hooks),
  };
}

export function publicHooks(cfg, project) {
  return Object.fromEntries(Object.entries(projectHooks(cfg, project)).map(([name, command]) => [name, !!command]));
}

export function runHook(command, { cwd, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    if (typeof command !== "string" || !command.trim()) {
      resolve({ exit: 0, stdout: "", stderr: "", command: null });
      return;
    }
    const child = spawnImpl("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    if (!child || typeof child.on !== "function") {
      resolve({ exit: 1, stdout: "", stderr: "hook runner failed", command });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({
        exit: result.exit,
        signal: result.signal || null,
        stdout: redacted(stdout),
        stderr: redacted(stderr || result.error || ""),
        command,
      });
    };
    child.on("error", error => finish({ exit: 1, error: error.message }));
    child.on("close", (code, signal) => finish({ exit: typeof code === "number" ? code : 1, signal }));
  });
}

export function hookResult(result, name) {
  return {
    hook: name,
    exit: result.exit,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    ok: result.exit === 0,
  };
}
