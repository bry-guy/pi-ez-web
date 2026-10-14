export const MANAGED_BY = "pi-ez-gateway";
export const NAME_LABEL = "pi-ez.dev/workspace";
export const REPO_ANNOTATION = "pi-ez.dev/repository";
export const WORKSPACE_PORT = 3141;
export const GITHUB_SECRET = "pi-ez-github-auth";
const GITHUB_DIR = "/run/secrets/pi-ez-github";
const DATA = "/data";
const HOME = `${DATA}/pi-ez-operator-home`;
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

export function slugFromRepository(repository) {
  const last = String(repository || "").trim().replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).pop() || "";
  const slug = last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return validName(slug) ? slug : null;
}

function meta(name, repository) {
  return {
    name: `ws-${name}`,
    labels: { "app.kubernetes.io/managed-by": MANAGED_BY, [NAME_LABEL]: name },
    annotations: { [REPO_ANNOTATION]: repository },
  };
}

export function pvcManifest({ name, repository, storage = "20Gi", storageClassName }) {
  return {
    apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(name, repository),
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage } }, ...(storageClassName ? { storageClassName } : {}) },
  };
}

export function serviceManifest({ name, repository }) {
  return {
    apiVersion: "v1", kind: "Service", metadata: meta(name, repository),
    spec: { selector: { [NAME_LABEL]: name }, ports: [{ name: "http", port: WORKSPACE_PORT, targetPort: WORKSPACE_PORT }] },
  };
}

export function deploymentManifest({ name, repository, image, serviceAccountName = null, runtimeClassName = null, secretName = null, envConfigMap = null, imagePullSecret = null, dindImage = "docker:28-dind" }) {
  if (!validName(name)) throw new Error("invalid workspace name");
  const env = [
    ["PORT", String(WORKSPACE_PORT)], ["PI_WEB_MODE", "real"],
    ["HOME", HOME], ["XDG_CONFIG_HOME", `${HOME}/.config`], ["XDG_DATA_HOME", `${HOME}/.local/share`], ["XDG_CACHE_HOME", `${HOME}/.cache`],
    ["PI_WEB_HOME", `${DATA}/pi-ez-web`], ["PI_CODING_AGENT_DIR", `${DATA}/pi-ez-agent`], ["PI_WEB_REPOS_ROOT", `${DATA}/repos`],
    ["PI_WEB_SEED_REPOSITORY", repository],
    ["PI_WEB_GITHUB_AUTH_FILE", `${GITHUB_DIR}/github-auth.json`],
    ...(runtimeClassName ? [["DOCKER_HOST", "tcp://127.0.0.1:2375"]] : []),
  ].map(([n, value]) => ({ name: n, value }));
  const envFrom = [
    ...(envConfigMap ? [{ configMapRef: { name: envConfigMap, optional: true } }] : []),
    ...(secretName ? [{ secretRef: { name: secretName } }] : []),
  ];
  const containers = [{
    name: "workspace", image, env, ...(envFrom.length ? { envFrom } : {}),
    ports: [{ name: "http", containerPort: WORKSPACE_PORT }],
    readinessProbe: { httpGet: { path: "/api/health", port: WORKSPACE_PORT }, periodSeconds: 10 },
    volumeMounts: [{ name: "data", mountPath: DATA }, { name: "github", mountPath: GITHUB_DIR, readOnly: true }],
  }];
  if (runtimeClassName) {
    // Privileged is confined to the sandbox VM; never emit it without a runtime class.
    containers.push({
      name: "docker", image: dindImage,
      env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
      securityContext: { privileged: true, runAsUser: 0 },
      volumeMounts: [{ name: "data", mountPath: "/var/lib/docker", subPath: "docker" }],
    });
  }
  return {
    apiVersion: "apps/v1", kind: "Deployment", metadata: meta(name, repository),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { [NAME_LABEL]: name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/managed-by": MANAGED_BY, [NAME_LABEL]: name } },
        spec: {
          ...(serviceAccountName ? { serviceAccountName, automountServiceAccountToken: true } : { automountServiceAccountToken: false }),
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(imagePullSecret ? { imagePullSecrets: [{ name: imagePullSecret }] } : {}),
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers,
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: `ws-${name}` } },
            // Optional so workspaces start before the first gateway login; kubelet refreshes it after.
            { name: "github", secret: { secretName: GITHUB_SECRET, optional: true, defaultMode: 0o440 } },
          ],
        },
      },
    },
  };
}
