import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const admitted = new Set();

function admissionError(code, message) {
  return Object.assign(new Error(message), { code, repositoryAdmission: true });
}

async function repositoryIdentity(repoPath) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: repoPath, encoding: "utf8" });
    const commonDir = stdout.trim();
    if (!commonDir) throw new Error("empty Git common directory");
    return await fs.realpath(path.resolve(repoPath, commonDir));
  } catch {
    throw admissionError("git_status_unavailable", "Could not determine the repository identity.");
  }
}

export async function assertRepositoryIdentity(expected, repoPath) {
  if (await repositoryIdentity(repoPath) !== expected) {
    throw admissionError("repository_changed", "The repository changed before the operation began.");
  }
}

export async function withRepositoryAdmission(repoPath, task) {
  const identity = await repositoryIdentity(repoPath);
  if (admitted.has(identity)) throw admissionError("repository_busy", "Another Git operation is already using this repository.");
  admitted.add(identity);
  try {
    return await task(identity);
  } finally {
    admitted.delete(identity);
  }
}
