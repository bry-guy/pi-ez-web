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
  assert.match(dockerfile, /ARG PI_WEB_BUILD_ID/);
  assert.match(dockerfile, /ARG PI_SYNC_BASE_COMMIT=d5c46a99a250affe206a65c42db72072aac89da8/);
  assert.equal(piSyncCommit, "d5c46a99a250affe206a65c42db72072aac89da8");
  assert.match(dockerfile, /COPY vendor\/pi-sync \/tmp\/pi-sync/);
  assert.match(dockerfile, /node_modules\/@bry-guy\/pi-sync/);
  const piSyncBuildRun = dockerfile
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .find(line => line.startsWith("RUN set -eux;"));
  assert.ok(piSyncBuildRun);
  const buildAt = piSyncBuildRun.indexOf("npm run build --prefix /tmp/pi-sync");
  const cleanAt = piSyncBuildRun.indexOf("npm cache clean --force");
  assert.ok(buildAt >= 0 && cleanAt > buildAt);
  assert.doesNotMatch(dockerfile, /git clone/);
  assert.doesNotMatch(dockerfile, /\b(mise|fnox|tofu|kubectl|yadm)\b/i);
  assert.doesNotMatch(dockerfile, /\bop\b/);
  assert.doesNotMatch(dockerfile, /MISE_|FNOX_|OP_VERSION|OPENTOFU_|KUBECTL_/);
  assert.match(dockerfile, /build-essential/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /pi-ez-web-git-credential-helper/);
  assert.match(dockerfile, /server\/git-credential-helper\.js "\$@"/);
  assert.match(dockerfile, /git config --system credential\.https:\/\/github\.com\.helper \/usr\/local\/bin\/pi-ez-web-git-credential-helper/);
  assert.equal(pkg.dependencies["@1password/sdk"], undefined);
  assert.equal(lock.packages[""].dependencies["@1password/sdk"], undefined);
  assert.equal(lock.packages["node_modules/@1password/sdk"], undefined);
  assert.equal(lock.packages["node_modules/@1password/sdk-core"], undefined);
  assert.equal(fs.existsSync(path.join(root, "server/onepassword.js")), false);
  assert.doesNotMatch(dockerfile, /1password|onepassword/i);
  assert.doesNotMatch(dockerfile, /not-a-real-service-account-token/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});

test("project hook capability is advertised by the server", () => {
  const version = fs.readFileSync(path.join(root, "server/version.js"), "utf8");
  assert.match(version, /project-hooks/);
});

test("self-hosting examples keep state persistent and secrets out of defaults", () => {
  const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const config = readJson("config.example.json");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const deployment = fs.readFileSync(path.join(root, "docs/deployment.md"), "utf8");
  const configuration = fs.readFileSync(path.join(root, "docs/configuration.md"), "utf8");

  assert.match(compose, /context: \./);
  assert.ok(compose.includes("${PI_WEB_BIND_ADDRESS:-127.0.0.1}:${PI_WEB_PORT:-3141}:3141"));
  assert.match(compose, /pi-ez-web-data:\/data/);
  assert.doesNotMatch(compose, /^\s+name: pi-ez-web-data$/m);
  assert.match(compose, /PI_WEB_HOME: \/data\/pi-ez-web/);
  assert.match(compose, /PI_CODING_AGENT_DIR: \/data\/pi-ez-agent/);
  assert.match(compose, /PI_WEB_REPOS_ROOT: \/data\/repos/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:3141\/ui-health/);
  assert.match(envExample, /PI_WEB_BIND_ADDRESS=127\.0\.0\.1/);
  assert.equal(config.projects.length, 0);
  assert.equal(config.pi.profile, null);
  assert.equal(config.pi.profileSource, "disabled");
  assert.equal(config.sync.serverUrl, null);
  assert.doesNotMatch(JSON.stringify(config), /token|secret|password|credential/i);

  for (const text of [readme, deployment, configuration]) {
    assert.doesNotMatch(text, /Node(?:\.js)? 20|temporary askpass|preview deployment|bry-guy|fnox|OP_SERVICE_ACCOUNT_TOKEN/i);
  }
  assert.match(configuration, /Compose `.env` file controls Compose interpolation only/);
  assert.match(configuration, /project_environment_source_missing/);
  assert.match(configuration, /set -e/);
  assert.match(configuration, /`\/data\/pi-ez-operator-home\/.pi\/worktrees`/);
  assert.match(deployment, /one named\s+volume/);
  assert.match(deployment, /project-scoped/);
  assert.match(deployment, /restore_volume="\$\(docker volume create\)"/);
  assert.match(deployment, /external: true/);
  assert.match(deployment, /Bare `docker compose` selects the original volume again/);
  assert.match(deployment, /export COMPOSE_FILE=compose\.yaml:compose\.restore\.yaml/);
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
