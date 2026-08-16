import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function manifest(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('preview Service selects only preview pods', () => {
  const preview = manifest('deploy/k8s-preview/service.yaml');

  assert.match(
    preview,
    /  selector:\n    app\.kubernetes\.io\/name: pi-ez-web\n    selfhost\.bry-guy\.net\/preview: "true"\n  ports:/,
  );
});

test('production pod labels do not change its immutable Deployment selector', () => {
  const deployment = manifest('deploy/k8s/deployment.yaml');

  assert.match(
    deployment,
    /  selector:\n    matchLabels:\n      app\.kubernetes\.io\/name: pi-ez-web\n  template:/,
  );
  assert.match(deployment, /        selfhost\.bry-guy\.net\/preview: "false"\n    spec:/);
});
