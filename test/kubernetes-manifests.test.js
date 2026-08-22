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

test('preview is a stateless UI-only workload backed by production APIs', () => {
  const deployment = manifest('deploy/k8s-preview/deployment.yaml');
  assert.match(deployment, /name: PI_WEB_UI_ONLY\n\s+value: "1"/);
  assert.match(deployment, /path: \/ui-health/);
  assert.match(deployment, /name: ghcr-pull/);
  assert.match(deployment, /selfhost\.bry-guy\.net\/capability-service: "true"/);
  assert.doesNotMatch(deployment, /initContainers:/);
  assert.doesNotMatch(deployment, /persistentVolumeClaim:/);
  assert.doesNotMatch(deployment, /secret:/);
  assert.doesNotMatch(deployment, /secretKeyRef:/);
  assert.doesNotMatch(deployment, /mountPath: \/data/);
  assert.doesNotMatch(deployment, /PI_WEB_HOME|KUBECONFIG|OP_SERVICE_ACCOUNT_TOKEN|PI_CODING_AGENT_DIR/);
});

test('preview rollback storage remains retained but is not mounted by the workload', () => {
  const storage = manifest('deploy/k8s-preview/storage.yaml');
  assert.match(storage, /argocd\.argoproj\.io\/sync-options: Prune=false/);
  assert.match(storage, /name: pi-ez-web-state-parent/);
});

test('production pod labels do not change its immutable Deployment selector', () => {
  const deployment = manifest('deploy/k8s/deployment.yaml');

  assert.match(
    deployment,
    /  selector:\n    matchLabels:\n      app\.kubernetes\.io\/name: pi-ez-web\n  template:/,
  );
  assert.match(deployment, /        selfhost\.bry-guy\.net\/preview: "false"\n    spec:/);
});
