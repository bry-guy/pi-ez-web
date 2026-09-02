import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const testRoot = path.dirname(fileURLToPath(import.meta.url));

function testFiles(dir, relative = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) return testFiles(path.join(dir, entry.name), file);
    return entry.name.endsWith(".test.js") ? [file] : [];
  });
}

const projectRoot = path.dirname(testRoot);

function run(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=2", path.join("test", file)], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.on("error", () => resolve(1));
    child.on("close", code => resolve(code ?? 1));
  });
}

const files = testFiles(testRoot).sort();
let next = 0;
let failed = false;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    if (await run(file) !== 0) failed = true;
  }
}
await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
process.exitCode = failed ? 1 : 0;
