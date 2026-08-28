import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspacePointer } from "../protocol.js";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
  (command: string, args: string[]): Promise<{ stdout: string; code?: number }>;
}

export async function deriveWorkspacePointer(cwd: string, runner: GitCommandRunner = defaultGitRunner(cwd)): Promise<WorkspacePointer | undefined> {
  const upstream = await runOptional(runner, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream) return undefined;
  const upstreamRef = upstream.trim();
  const separator = upstreamRef.indexOf("/");
  if (separator <= 0 || separator === upstreamRef.length - 1) return undefined;
  const remoteName = upstreamRef.slice(0, separator);
  const branch = upstreamRef.slice(separator + 1);
  const remote = await runOptional(runner, "git", ["remote", "get-url", remoteName]);
  const commit = await runOptional(runner, "git", ["rev-parse", "@{upstream}"]);
  const gitRemote = sanitizeRemote(remote);
  if (!gitRemote || !commit) return undefined;
  return { gitRemote, branch, commit: commit.trim() };
}

function sanitizeRemote(value: string | undefined): string | undefined {
  const remote = String(value || "").trim();
  if (!remote || /[\u0000\r\n\s]/.test(remote)) return undefined;
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "") || undefined;
  } catch {
    return remote;
  }
}

function defaultGitRunner(cwd: string): GitCommandRunner {
  return async (command, args) => {
    try {
      const result = await execFileAsync(command, args, { cwd, maxBuffer: 256 * 1024 });
      return { stdout: result.stdout, code: 0 };
    } catch (error) {
      const value = error as { stdout?: string; code?: number };
      return { stdout: value.stdout ?? "", code: value.code };
    }
  };
}

async function runOptional(runner: GitCommandRunner, command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runner(command, args);
    if (result.code !== undefined && result.code !== 0) return undefined;
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}
