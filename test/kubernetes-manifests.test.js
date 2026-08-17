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
  assert.match(deployment, /pi\.profile \|\|= 'https:\/\/github\.com\/bry-guy\/dotfiles';/);
  assert.match(deployment, /git:github\.com\/nicobailon\/pi-mcp-adapter/);
  assert.match(deployment, /defaultMode: 'lite'/);
});

test('production pod labels do not change its immutable Deployment selector', () => {
  const deployment = manifest('deploy/k8s/deployment.yaml');

  assert.match(
    deployment,
    /  selector:\n    matchLabels:\n      app\.kubernetes\.io\/name: pi-ez-web\n  template:/,
  );
  assert.match(deployment, /        selfhost\.bry-guy\.net\/preview: "false"\n    spec:/);
});
