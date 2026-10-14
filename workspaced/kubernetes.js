import { deploymentManifest, GITHUB_SECRET, pvcManifest, serviceManifest, MANAGED_BY, NAME_LABEL, REPO_ANNOTATION, WORKSPACE_PORT } from "./manifests.js";

// Workspaces as ws-<name> PVC + Service + Deployment. The cluster's labels and
// annotations are the record of what exists; workspaced keeps no database.
export function kubernetesConfig(env = process.env) {
  const namespace = env.WORKSPACED_NAMESPACE || "pi-ez-workspaces";
  return {
    namespace,
    image: env.WORKSPACE_IMAGE || "ghcr.io/bry-guy/pi-ez-web:latest",
    storage: env.WORKSPACE_STORAGE || "20Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS || null,
    envConfigMap: env.WORKSPACE_ENV_CONFIGMAP || null,
    imagePullSecret: env.WORKSPACE_IMAGE_PULL_SECRET || null,
  };
}

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export function kubernetesProvider({ kube, config = kubernetesConfig() }) {
  const ns = config.namespace;
  const apps = `/apis/apps/v1/namespaces/${ns}/deployments`;
  const core = kind => `/api/v1/namespaces/${ns}/${kind}`;
  const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);

  async function create(path, manifest) {
    const res = await kube.request("POST", path, manifest);
    if (res.status === 409 || (res.status >= 200 && res.status < 300)) return;
    throw httpError(res.body?.message || `kubernetes ${res.status}`, 502, "kubernetes_error");
  }

  return {
    async list() {
      const res = await kube.request("GET", `${apps}?labelSelector=${selector}`);
      if (res.status !== 200) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      return (res.body.items || []).map(d => ({
        name: d.metadata.labels?.[NAME_LABEL],
        repository: d.metadata.annotations?.[REPO_ANNOTATION] || null,
        ready: (d.status?.readyReplicas || 0) > 0,
        containers: !!d.spec?.template?.spec?.runtimeClassName,
      }));
    },
    async create({ name, repository, runtimeClassName = null, secretName = null }) {
      const existing = await kube.request("GET", `${apps}/ws-${name}`);
      if (existing.status === 200 && existing.body?.metadata?.annotations?.[REPO_ANNOTATION] !== repository) {
        throw httpError("workspace name taken", 409, "workspace_name_taken");
      }
      // Per-project cluster grants are opt-in: an operator-created ws-<name> ServiceAccount.
      const sa = await kube.request("GET", `${core("serviceaccounts")}/ws-${name}`);
      await create(core("persistentvolumeclaims"), pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName }));
      await create(core("services"), serviceManifest({ name, repository }));
      await create(apps, deploymentManifest({ name, repository, image: config.image, serviceAccountName: sa.status === 200 ? `ws-${name}` : null,
        runtimeClassName, secretName, envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret }));
    },
    async remove(name, { purge = false } = {}) {
      // The PVC holds unpushed work; keep it unless explicitly purged.
      const paths = [`${apps}/ws-${name}`, `${core("services")}/ws-${name}`, ...(purge ? [`${core("persistentvolumeclaims")}/ws-${name}`] : [])];
      for (const path of paths) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      }
    },
    upstream: name => `http://ws-${name}.${ns}.svc.cluster.local:${WORKSPACE_PORT}`,
    // Workers mount this Secret read-only; kubelet refreshes it after updates.
    async setGitHubAuth(auth) {
      const path = `${core("secrets")}/${GITHUB_SECRET}`;
      if (!auth) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
        return;
      }
      const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: GITHUB_SECRET }, type: "Opaque",
        stringData: { "github-auth.json": JSON.stringify(auth) } };
      let res = await kube.request("PUT", path, secret);
      if (res.status === 404) res = await kube.request("POST", core("secrets"), secret);
      if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    },
  };
}
