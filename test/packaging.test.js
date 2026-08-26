import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  assert.match(dockerfile, /ARG PI_SYNC_COMMIT=667213eda54392b9ba546e5bd6dc896f384ec755/);
  assert.equal(piSyncCommit, "667213eda54392b9ba546e5bd6dc896f384ec755");
  assert.match(dockerfile, /COPY vendor\/pi-sync \/tmp\/pi-sync/);
  assert.match(dockerfile, /node_modules\/@bry-guy\/pi-sync/);
  assert.doesNotMatch(dockerfile, /git clone/);
  assert.match(dockerfile, /FNOX_VERSION=v1\.25\.1/);
  assert.match(dockerfile, /OP_VERSION=v2\.34\.0/);
  assert.match(dockerfile, /OPENTOFU_VERSION=1\.11\.5/);
  assert.match(dockerfile, /KUBECTL_VERSION=v1\.34\.5/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /pi-ez-web-git-credential-helper/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});

test("project hook capability is advertised by the server", () => {
  const version = fs.readFileSync(path.join(root, "server/version.js"), "utf8");
  assert.match(version, /project-hooks/);
});

test("k3s deployment uses private image GitOps wiring", () => {
  const deployment = fs.readFileSync(path.join(root, "deploy/k8s/deployment.yaml"), "utf8");
  const kustomization = fs.readFileSync(path.join(root, "deploy/k8s/kustomization.yaml"), "utf8");
  const application = fs.readFileSync(path.join(root, "deploy/argocd/app-pi-ez-web.yaml"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-image.yml"), "utf8");

  assert.match(deployment, /imagePullSecrets:[\s\S]*name: ghcr-pull/);
  assert.doesNotMatch(deployment, /localhost\/pi-ez-web|:latest/);
  assert.match(kustomization, /ghcr\.io\/bry-guy\/pi-ez-web/);
  assert.match(kustomization, /digest: sha256:/);
  assert.match(application, /automated:[\s\S]*prune: true[\s\S]*selfHeal: true/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker\/login-action/);
  assert.match(workflow, /Stage image in preview[\s\S]*deploy\/k8s-preview\/kustomization\.yaml/);
  assert.match(workflow, /Verify preview artifact[\s\S]*ui-health[\s\S]*buildId/);
  assert.match(workflow, /Promote verified image to production[\s\S]*deploy\/k8s\/kustomization\.yaml/);
  assert.match(workflow, /TAILSCALE_FEDERATED_CLIENT_ID/);
  assert.match(workflow, /TAILSCALE_FEDERATED_AUDIENCE/);
  assert.match(workflow, /tags: tag:ci/);
  assert.doesNotMatch(workflow, /TAILSCALE_OAUTH_CLIENT_SECRET|oauth-secret:/);
  assert.equal(workflow.match(/steps\.build\.outputs\.digest/g)?.length, 2);
  assert.match(workflow, /force-with-lease=.*preview\/pi/);
  assert.doesNotMatch(workflow, /git push --force origin/);
});

test("image digest updater supports production and preview manifests", () => {
  const script = path.join(root, "scripts/update-image-digest.py");
  const digest = `sha256:${"1".repeat(64)}`;
  const image = "ghcr.io/bry-guy/pi-ez-web";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ez-web-digest-"));

  try {
    for (const source of ["deploy/k8s/kustomization.yaml", "deploy/k8s-preview/kustomization.yaml"]) {
      const target = path.join(temp, path.basename(path.dirname(source)), "kustomization.yaml");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, source), target);
      execFileSync("python3", [script, target, image, digest]);
      assert.match(fs.readFileSync(target, "utf8"), new RegExp(`digest: ${digest}`));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
