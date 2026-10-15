import { deploymentManifest, GITHUB_SECRET, MODEL_SECRET, pvcManifest, serviceManifest, MANAGED_BY, NAME_LABEL, PIN_ANNOTATION, REPO_ANNOTATION, WORKSPACE_PORT } from "./manifests.js";

const MERGE_PATCH = "application/merge-patch+json";

export function deploymentState(d) {
  if ((d.spec?.replicas ?? 1) === 0) return "sleeping";
  return (d.status?.readyReplicas || 0) > 0 ? "running" : "starting";
}

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

export function kubernetesProvider({ kube, config = kubernetesConfig(), removeTimeoutMs = 90_000, removePollMs = 2_000 }) {
  const ns = config.namespace;
  const apps = `/apis/apps/v1/namespaces/${ns}/deployments`;
  const core = kind => `/api/v1/namespaces/${ns}/${kind}`;
  const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);

  // Workers mount these Secrets read-only; kubelet refreshes them after updates.
  async function putSecretFile(name, key, content) {
    const path = `${core("secrets")}/${name}`;
    if (content === null) {
      const res = await kube.request("DELETE", path);
      if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      return;
    }
    const secret = { apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: { [key]: content } };
    let res = await kube.request("PUT", path, secret);
    if (res.status === 404) res = await kube.request("POST", core("secrets"), secret);
    if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
  }

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
        state: deploymentState(d),
        pinned: d.metadata.annotations?.[PIN_ANNOTATION] === "true",
        containers: !!d.spec?.template?.spec?.runtimeClassName,
      }));
    },
    async scale(name, replicas) {
      const res = await kube.request("PATCH", `${apps}/ws-${name}`, { spec: { replicas } }, MERGE_PATCH);
      if (res.status === 404) throw httpError("no such workspace", 404, "no_such_workspace");
      if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    },
    async setPinned(name, pinned) {
      // The annotation is the record; workspaced keeps no database.
      const res = await kube.request("PATCH", `${apps}/ws-${name}`, { metadata: { annotations: { [PIN_ANNOTATION]: pinned ? "true" : null } } }, MERGE_PATCH);
      if (res.status === 404) throw httpError("no such workspace", 404, "no_such_workspace");
      if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
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
      // Return only once the pod (and purged PVC) are gone, so a re-add starts clean.
      const pods = `${core("pods")}?labelSelector=${encodeURIComponent(`${NAME_LABEL}=${name}`)}`;
      const deadline = Date.now() + removeTimeoutMs;
      for (;;) {
        const podRes = await kube.request("GET", pods);
        const pvcGone = !purge || (await kube.request("GET", `${core("persistentvolumeclaims")}/ws-${name}`)).status === 404;
        if (pvcGone && !(podRes.body?.items || []).length) return;
        if (Date.now() > deadline) throw httpError("workspace is still terminating", 504, "workspace_remove_timeout");
        await new Promise(r => setTimeout(r, removePollMs));
      }
    },
    upstream: name => `http://ws-${name}.${ns}.svc.cluster.local:${WORKSPACE_PORT}`,
    setGitHubAuth: auth => putSecretFile(GITHUB_SECRET, "github-auth.json", auth ? JSON.stringify(auth) : null),
    setModelAuth: content => putSecretFile(MODEL_SECRET, "auth.json", content),
  };
}
