import { DEFAULT_GRANT } from "./grants.js";
import { deploymentManifest, GITHUB_SECRET, GRANT_ANNOTATION, MODEL_SECRET, pvcManifest, serviceManifest, MANAGED_BY, NAME_LABEL, PIN_ANNOTATION, REPO_ANNOTATION, WORKSPACE_PORT } from "./manifests.js";

const MERGE_PATCH = "application/merge-patch+json";
// Merges containers by name instead of replacing the list.
const STRATEGIC_PATCH = "application/strategic-merge-patch+json";

export function deploymentState(d) {
  if ((d.spec?.replicas ?? 1) === 0) return "sleeping";
  return (d.status?.readyReplicas || 0) > 0 ? "running" : "starting";
}

// Workspaces as ws-<name> PVC + Service + Deployment. The cluster's labels and
// annotations are the record of what exists; workspaced keeps no database.
// Requests keep a worker's share of a shared node; the memory limit stops one
// worker from taking the node. No CPU limit by default. An empty value unsets one.
export function kubernetesConfig(env = process.env) {
  const namespace = env.WORKSPACED_NAMESPACE || "pi-ez-workspaces";
  const set = values => Object.fromEntries(Object.entries(values).filter(([, v]) => v));
  return {
    namespace,
    image: env.WORKSPACE_IMAGE || "ghcr.io/bry-guy/pi-ez-web:latest",
    storage: env.WORKSPACE_STORAGE || "20Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS || null,
    envConfigMap: env.WORKSPACE_ENV_CONFIGMAP || null,
    imagePullSecret: env.WORKSPACE_IMAGE_PULL_SECRET || null,
    resources: {
      requests: set({ cpu: env.WORKSPACE_CPU_REQUEST ?? "250m", memory: env.WORKSPACE_MEMORY_REQUEST ?? "512Mi" }),
      limits: set({ cpu: env.WORKSPACE_CPU_LIMIT ?? null, memory: env.WORKSPACE_MEMORY_LIMIT ?? "4Gi" }),
    },
  };
}

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// Each grant may place workers in its own namespace (default: config.namespace),
// so a powerful grant's ServiceAccount and Secrets never share a namespace with
// ordinary workers.
export function kubernetesProvider({ kube, config = kubernetesConfig(), grants = {}, removeTimeoutMs = 90_000, removePollMs = 2_000 }) {
  const home = config.namespace;
  const namespaces = [...new Set([home, ...Object.values(grants).map(g => g.namespace).filter(Boolean)])];
  const nsOf = grant => grant?.namespace || home;
  const apps = ns => `/apis/apps/v1/namespaces/${ns}/deployments`;
  const core = (kind, ns = home) => `/api/v1/namespaces/${ns}/${kind}`;
  const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);
  const located = new Map(); // workspace name → namespace, refreshed by list/locate

  // Workers mount these Secrets read-only; kubelet refreshes them after updates.
  // They live in every worker namespace.
  async function putSecretFile(name, key, content) {
    for (const ns of namespaces) {
      const path = `${core("secrets", ns)}/${name}`;
      if (content === null) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
        continue;
      }
      const secret = { apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: { [key]: content } };
      let res = await kube.request("PUT", path, secret);
      if (res.status === 404) res = await kube.request("POST", core("secrets", ns), secret);
      if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    }
  }

  async function create(path, manifest) {
    const res = await kube.request("POST", path, manifest);
    if (res.status === 409 || (res.status >= 200 && res.status < 300)) return;
    throw httpError(res.body?.message || `kubernetes ${res.status}`, 502, "kubernetes_error");
  }

  // The worker's Deployment, wherever its grant put it; null if none.
  async function locate(name) {
    const order = located.has(name) ? [located.get(name), ...namespaces.filter(n => n !== located.get(name))] : namespaces;
    for (const ns of order) {
      const res = await kube.request("GET", `${apps(ns)}/ws-${name}`);
      if (res.status === 200) { located.set(name, ns); return { ns, deployment: res.body }; }
      if (res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    }
    located.delete(name);
    return null;
  }
  async function mustLocate(name) {
    const found = await locate(name);
    if (!found) throw httpError("no such workspace", 404, "no_such_workspace");
    return found;
  }
  async function patch(name, body, type = MERGE_PATCH) {
    const { ns } = await mustLocate(name);
    const res = await kube.request("PATCH", `${apps(ns)}/ws-${name}`, body, type);
    if (res.status === 404) throw httpError("no such workspace", 404, "no_such_workspace");
    if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
  }

  return {
    async list() {
      const out = [];
      for (const ns of namespaces) {
        const res = await kube.request("GET", `${apps(ns)}?labelSelector=${selector}`);
        if (res.status !== 200) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
        for (const d of res.body.items || []) {
          const name = d.metadata.labels?.[NAME_LABEL];
          located.set(name, ns);
          out.push({
            name,
            repository: d.metadata.annotations?.[REPO_ANNOTATION] || null,
            grant: d.metadata.annotations?.[GRANT_ANNOTATION] || DEFAULT_GRANT,
            ready: (d.status?.readyReplicas || 0) > 0,
            state: deploymentState(d),
            pinned: d.metadata.annotations?.[PIN_ANNOTATION] === "true",
            containers: !!d.spec?.template?.spec?.runtimeClassName,
            resources: d.spec?.template?.spec?.containers?.[0]?.resources ?? null,
            outdated: d.spec?.template?.spec?.containers?.[0]?.image !== config.image,
          });
        }
      }
      return out;
    },
    scale: (name, replicas) => patch(name, { spec: { replicas } }),
    // Restarts an awake worker; a sleeping one just starts on it next wake.
    upgrade: name => patch(name, { spec: { template: { spec: { containers: [{ name: "workspace", image: config.image, resources: config.resources }] } } } }, STRATEGIC_PATCH),
    // The annotation is the record; workspaced keeps no database.
    setPinned: (name, pinned) => patch(name, { metadata: { annotations: { [PIN_ANNOTATION]: pinned ? "true" : null } } }),
    async create({ name, repository, grant, runtimeClassName = null }) {
      const existing = await locate(name);
      if (existing && existing.deployment.metadata?.annotations?.[REPO_ANNOTATION] !== repository) {
        throw httpError("workspace name taken", 409, "workspace_name_taken");
      }
      const ns = existing?.ns || nsOf(grant);
      if (ns !== nsOf(grant)) throw httpError("this workspace was created with a grant in another namespace; remove it first", 409, "grant_namespace_mismatch");
      await create(core("persistentvolumeclaims", ns), pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName }));
      await create(core("services", ns), serviceManifest({ name, repository }));
      await create(apps(ns), deploymentManifest({ name, repository, image: config.image, grant, runtimeClassName,
        envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret, resources: config.resources }));
      located.set(name, ns);
    },
    // Re-grant in place. The PVC can't move namespaces, so a grant with another
    // namespace means remove + re-add (a fresh clone).
    async setGrant(name, grant) {
      const { ns, deployment } = await mustLocate(name);
      if (ns !== nsOf(grant)) throw httpError("that grant runs in another namespace; remove the project and add it again with it", 409, "grant_namespace_mismatch");
      const repository = deployment.metadata.annotations?.[REPO_ANNOTATION];
      const fresh = deploymentManifest({ name, repository, image: deployment.spec.template.spec.containers[0].image, grant,
        runtimeClassName: deployment.spec.template.spec.runtimeClassName || null, envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret, resources: config.resources });
      // Merge patch replaces arrays (containers, envFrom) wholesale and keeps replicas.
      await patch(name, { metadata: { annotations: { [GRANT_ANNOTATION]: grant.name } }, spec: { template: fresh.spec.template } });
    },
    async remove(name, { purge = false } = {}) {
      const ns = (await locate(name))?.ns || home;
      // The PVC holds unpushed work; keep it unless explicitly purged.
      const paths = [`${apps(ns)}/ws-${name}`, `${core("services", ns)}/ws-${name}`, ...(purge ? [`${core("persistentvolumeclaims", ns)}/ws-${name}`] : [])];
      for (const path of paths) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      }
      // Return only once the pod (and purged PVC) are gone, so a re-add starts clean.
      const pods = `${core("pods", ns)}?labelSelector=${encodeURIComponent(`${NAME_LABEL}=${name}`)}`;
      const deadline = Date.now() + removeTimeoutMs;
      for (;;) {
        const podRes = await kube.request("GET", pods);
        const pvcGone = !purge || (await kube.request("GET", `${core("persistentvolumeclaims", ns)}/ws-${name}`)).status === 404;
        if (pvcGone && !(podRes.body?.items || []).length) { located.delete(name); return; }
        if (Date.now() > deadline) throw httpError("workspace is still terminating", 504, "workspace_remove_timeout");
        await new Promise(r => setTimeout(r, removePollMs));
      }
    },
    upstream: name => `http://ws-${name}.${located.get(name) || home}.svc.cluster.local:${WORKSPACE_PORT}`,
    setGitHubAuth: auth => putSecretFile(GITHUB_SECRET, "github-auth.json", auth ? JSON.stringify(auth) : null),
    setModelAuth: content => putSecretFile(MODEL_SECRET, "auth.json", content),
  };
}
