import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("production image installs the Pi SDK as a runtime dependency", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const sdk = "@earendil-works/pi-coding-agent";

  assert.ok(pkg.dependencies[sdk], "Pi SDK must be a production dependency");
  assert.equal(pkg.devDependencies?.[sdk], undefined);
  assert.equal(pkg.peerDependencies?.[sdk], undefined);
  assert.equal(lock.packages[""].dependencies[sdk], pkg.dependencies[sdk]);
  assert.notEqual(lock.packages[`node_modules/${sdk}`].dev, true);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});
