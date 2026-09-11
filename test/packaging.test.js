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
  const piSyncCommit = fs.readFileSync(path.join(root, "vendor/pi-sync/UPSTREAM_COMMIT"), "utf8").trim();
  const runtimeDependencies = ["@earendil-works/pi-coding-agent", "dompurify", "highlight.js", "marked"];

  for (const dependency of runtimeDependencies) {
    assert.ok(pkg.dependencies[dependency], `${dependency} must be a production dependency`);
    assert.equal(pkg.devDependencies?.[dependency], undefined);
    assert.equal(pkg.peerDependencies?.[dependency], undefined);
    assert.equal(lock.packages[""].dependencies[dependency], pkg.dependencies[dependency]);
    assert.notEqual(lock.packages[`node_modules/${dependency}`].dev, true);
  }
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /MISE_VERSION=v2026\.5\.15/);
  assert.match(dockerfile, /ARG PI_WEB_BUILD_ID/);
  assert.match(dockerfile, /ARG PI_SYNC_BASE_COMMIT=d5c46a99a250affe206a65c42db72072aac89da8/);
  assert.equal(piSyncCommit, "d5c46a99a250affe206a65c42db72072aac89da8");
  assert.match(dockerfile, /COPY vendor\/pi-sync \/tmp\/pi-sync/);
  assert.match(dockerfile, /node_modules\/@bry-guy\/pi-sync/);
  assert.doesNotMatch(dockerfile, /git clone/);
  assert.match(dockerfile, /FNOX_VERSION=v1\.25\.1/);
  assert.match(dockerfile, /OP_VERSION=v2\.34\.0/);
  assert.match(dockerfile, /OPENTOFU_VERSION=1\.11\.5/);
  assert.match(dockerfile, /KUBECTL_VERSION=v1\.34\.5/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /\byadm\b/);
  assert.match(dockerfile, /pi-ez-web-git-credential-helper/);
  assert.match(dockerfile, /node --input-type=module --eval/);
  assert.match(dockerfile, /server\/onepassword\.js/);
  assert.match(dockerfile, /@1password\/sdk/);
  assert.doesNotMatch(dockerfile, /not-a-real-service-account-token/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});

test("project hook capability is advertised by the server", () => {
  const version = fs.readFileSync(path.join(root, "server/version.js"), "utf8");
  assert.match(version, /project-hooks/);
});

test("image publication workflow publishes immutable GHCR images", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-image.yml"), "utf8");

  assert.match(workflow, /permissions:\n  contents: read\n  packages: write\n/);
  assert.doesNotMatch(workflow, /contents: write|id-token: write/);
  assert.match(workflow, /group: pi-ez-web-image-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /preview|startsWith\(github\.ref_name/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker\/login-action/);
  assert.match(workflow, /tag="sha-\$\{source_sha\}"/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(workflow, /PI_WEB_BUILD_ID=\$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.doesNotMatch(
    workflow,
    /Stage image in preview|deploy\/k8s(?:-preview)?\/kustomization\.yaml|preview\/pi|update-image-digest|tailscale\/github-action|git push|Verify preview artifact|Promote verified image/
  );
  assert.equal(workflow.match(/steps\.build\.outputs\.digest/g)?.length ?? 0, 0);
});
