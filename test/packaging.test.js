import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("production image installs the Pi SDK and browser Markdown libraries as runtime dependencies", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const runtimeDependencies = ["@earendil-works/pi-coding-agent", "dompurify", "marked"];

  for (const dependency of runtimeDependencies) {
    assert.ok(pkg.dependencies[dependency], `${dependency} must be a production dependency`);
    assert.equal(pkg.devDependencies?.[dependency], undefined);
    assert.equal(pkg.peerDependencies?.[dependency], undefined);
    assert.equal(lock.packages[""].dependencies[dependency], pkg.dependencies[dependency]);
    assert.notEqual(lock.packages[`node_modules/${dependency}`].dev, true);
  }
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /MISE_VERSION=v2026\.5\.15/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /pi-ez-web-git-credential-helper/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});

test("project hook capability is advertised by the server", () => {
  const version = fs.readFileSync(path.join(root, "server/version.js"), "utf8");
  assert.match(version, /project-hooks/);
});
