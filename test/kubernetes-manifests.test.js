import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function manifest(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('production and preview Services select only their own pods', () => {
  const production = manifest('deploy/k8s/service.yaml');
  const preview = manifest('deploy/k8s-preview/service.yaml');

  assert.match(
    production,
    /  selector:\n    app\.kubernetes\.io\/name: pi-ez-web\n    selfhost\.bry-guy\.net\/preview: "false"\n  ports:/,
  );
  assert.match(
    preview,
    /  selector:\n    app\.kubernetes\.io\/name: pi-ez-web\n    selfhost\.bry-guy\.net\/preview: "true"\n  ports:/,
  );
});

test('preview initializes Bryan’s Pi profile with a package fallback', () => {
  const deployment = manifest('deploy/k8s-preview/deployment.yaml');
  assert.match(deployment, /pi\.profile === 'https:\/\/github\.com\/bry-guy\/dotfiles\/blob\/main\/\.pi\/agent\/settings\.json'/);
  assert.match(deployment, /pi\.profile = 'https:\/\/github\.com\/bry-guy\/dotfiles';/);
  assert.match(deployment, /git:github\.com\/nicobailon\/pi-mcp-adapter/);
  assert.doesNotMatch(deployment, /const ponytailDir|defaultMode: 'lite'/);
  assert.match(deployment, /name: MISE_TRUSTED_CONFIG_PATHS\n\s+value: \/data\/pi-ez-agent\/git\/github\.com/);
  assert.match(deployment, /name: PI_WEB_MODE\n\s+value: real/);
  assert.match(deployment, /claimName: pi-ez-web-state-parent/);
  assert.match(deployment, /mountPath: \/data\n\s+subPath: preview/);
  assert.doesNotMatch(deployment, /name: KUBECONFIG/);
  assert.doesNotMatch(deployment, /name: OP_SERVICE_ACCOUNT_TOKEN|name: operator-secrets/);
});

test('production and preview run the configured prestart dotfiles command', () => {
  const deployments = [
    manifest('deploy/k8s/deployment.yaml'),
    manifest('deploy/k8s-preview/deployment.yaml'),
  ];
  const revisions = deployments.map(deployment => deployment.match(/name: DOTFILES_REVISION\n\s+value: ([0-9a-f]{40})/)?.[1]);
  assert.equal(revisions[0], revisions[1]);
  assert.match(revisions[0], /^[0-9a-f]{40}$/);

  for (const deployment of deployments) {
    assert.match(deployment, /name: DOTFILES_REPOSITORY\n\s+value: https:\/\/github\.com\/bry-guy\/dotfiles\.git/);
    assert.match(deployment, /name: PI_WEB_PRESTART_TIMEOUT_MS\n\s+value: "120000"/);
    assert.match(deployment, /name: PI_WEB_PRESTART_COMMAND\n\s+value: \|[\s\S]*yadm clone --no-bootstrap --no-checkout/);
    assert.match(deployment, /yadm cat-file -e[\s\S]*yadm fetch --no-tags origin/);
    assert.match(deployment, /yadm reset --hard[\s\S]*yadm alt[\s\S]*yadm rev-parse HEAD/);
    assert.match(deployment, /git config --global --replace-all credential\.helper \/usr\/local\/bin\/pi-ez-web-git-credential-helper/);
    assert.doesNotMatch(deployment, /yadm bootstrap|script\/setup|script\/install/);
    assert.match(deployment, /name: HOME\n\s+value: \/data\/pi-ez-operator-home/);
    assert.match(deployment, /name: XDG_CONFIG_HOME\n\s+value: \/data\/pi-ez-operator-home\/\.config/);
    assert.match(deployment, /name: PI_WEB_HOME\n\s+value: \/data\/pi-ez-web/);
    assert.match(deployment, /name: PI_CODING_AGENT_DIR\n\s+value: \/data\/pi-ez-agent/);
    assert.ok(deployment.indexOf('yadm reset --hard') < deployment.indexOf('git config --global --replace-all'));
  }
});

test('production pod labels do not change its immutable Deployment selector', () => {
  const deployment = manifest('deploy/k8s/deployment.yaml');

  assert.match(
    deployment,
    /  selector:\n    matchLabels:\n      app\.kubernetes\.io\/name: pi-ez-web\n  template:/,
  );
  assert.match(deployment, /        selfhost\.bry-guy\.net\/preview: "false"\n    spec:/);
});
