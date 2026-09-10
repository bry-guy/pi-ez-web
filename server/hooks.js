import { spawn } from "node:child_process";
import { normalizeHookSets, normalizeHooks } from "./config.js";
import { redact } from "./redaction.js";

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const HOOK_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "MISE_ENV",
  "PI_WEB_HOME", "PI_CODING_AGENT_DIR", "PI_WEB_REPOS_ROOT", "PI_EZ_WEB_REPO_ROOT", "PI_WEB_ONEPASSWORD_TOKEN_FILE",
  "PI_WEB_MODE", "PI_WEB_BUILD_ID", "PI_SYNC_SERVER_URL", "PI_WEB_SYNC_ALL_CONVERSATIONS", "PI_WEB_GITHUB_CLIENT_ID", "PORT",
];

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function hookEnvironment(source = process.env) {
  return Object.fromEntries(HOOK_ENV_KEYS
    .filter(name => source?.[name] !== undefined)
    .map(name => [name, String(source[name])]));
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

function terminate(child, signal) {
  if (!child) return;
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill?.(signal); } catch {}
}

function appendOutput(current, chunk, limit) {
  const value = String(chunk);
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return { value: current, truncated: true };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= remaining) return { value: current + value, truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString("utf8"), truncated: true };
}

export function runHook(command, {
  cwd,
  env = process.env,
  spawnImpl = spawn,
  report = null,
  signal = null,
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise(resolve => {
    if (typeof command !== "string" || !command.trim()) {
      resolve({ exit: 0, stdout: "", stderr: "", command: null });
      return;
    }
    const startedAt = Date.now();
    const safeCommand = redact(command);
    const timeout = positive(timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
    const outputLimit = positive(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    const hookEnv = hookEnvironment(env);
    let child;
    let settled = false;
    let stopReason = null;
    let timeoutTimer;
    let killTimer;
    let abortHandler;
    let stdout = "";
    let stderr = "";
    report?.({ type: "process_start", phase: "hook", command: safeCommand, cwd, message: "Running configured hook." });

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (!stopReason) clearTimeout(killTimer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      const safeStdout = redact(stdout, { maxLength: outputLimit });
      const safeStderr = [
        redact(stderr, { maxLength: outputLimit }),
        redact(result.error || "", { maxLength: 1000 }),
      ].filter(Boolean).join("\n");
      const finalResult = {
        exit: result.exit,
        signal: result.signal || null,
        stdout: safeStdout,
        stderr: safeStderr,
        command,
      };
      report?.({
        type: "process_end",
        phase: "hook",
        command: safeCommand,
        cwd,
        stream: safeStderr ? "stderr" : "stdout",
        output: safeStderr || safeStdout,
        exit: finalResult.exit,
        durationMs: Date.now() - startedAt,
        message: finalResult.exit === 0 ? "Configured hook completed." : "Configured hook failed.",
      });
      resolve(finalResult);
    };

    const stop = reason => {
      if (settled || stopReason) return;
      stopReason = reason;
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminate(child, "SIGKILL");
        finish({ ...reason, signal: "SIGKILL" });
      }, 500);
    };

    const consume = (stream, chunk) => {
      const result = appendOutput(stream === "stdout" ? stdout : stderr, chunk, outputLimit);
      if (stream === "stdout") stdout = result.value;
      else stderr = result.value;
      report?.({ type: "process_output", phase: "hook", command: safeCommand, cwd, stream, output: redact(chunk, { maxLength: 12_000 }) });
      if (result.truncated) stop({ exit: 1, signal: "SIGTERM", error: "Hook output exceeded its limit." });
    };

    try {
      child = spawnImpl("/bin/sh", ["-c", command], {
        cwd,
        env: hookEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ exit: 1, error: error.message });
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish({ exit: 1, error: "hook runner failed" });
      return;
    }
    child.stdout?.on("data", chunk => consume("stdout", chunk));
    child.stderr?.on("data", chunk => consume("stderr", chunk));
    child.on("error", error => finish(stopReason || { exit: 1, error: error.message }));
    child.on("close", (code, childSignal) => finish(stopReason || { exit: typeof code === "number" ? code : 1, signal: childSignal }));
    timeoutTimer = setTimeout(() => stop({ exit: 1, signal: "SIGTERM", error: "Hook timed out." }), timeout);
    abortHandler = () => stop({ exit: 1, signal: "SIGTERM", error: "Hook cancelled." });
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

export function hookResult(result, name) {
  return {
    hook: name,
    exit: result.exit,
    signal: result.signal || null,
    stdout: redact(result.stdout || ""),
    stderr: redact(result.stderr || ""),
    command: redact(result.command || ""),
    ok: result.exit === 0,
  };
}
