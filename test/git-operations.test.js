import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("fetch configures the environment-first Git credential helper", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-operation-"));
  const bin = path.join(tmp, "bin");
  const check = path.join(tmp, "check");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nset -eu\ntest \"$GIT_TERMINAL_PROMPT\" = 0\ntest -x \"$GIT_ASKPASS\"\n\"$GIT_ASKPASS\" \"Password for 'https://github.com/example/repo':\" > \"$GIT_CHECK\"\n");
  fs.chmodSync(path.join(bin, "git"), 0o700);
  const moduleUrl = pathToFileURL(path.join(root, "server", "workspaces.js"));
  const script = `import { fetchRepositoryAsync } from ${JSON.stringify(moduleUrl.href)}; await fetchRepositoryAsync(process.argv[1]);`;
  try {
    const result = await run(process.execPath, ["--input-type=module", "-e", script, tmp], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CHECK: check, PI_WEB_GITHUB_TOKEN: "environment-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(check, "utf8"), "environment-token\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
