import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { inClusterKube } from "./kube.js";
import { GitHubClient, GitHubDeviceFlowManager } from "../github.js";
import { deploymentManifest, GITHUB_SECRET, pvcManifest, serviceManifest, slugFromRepository, validName, MANAGED_BY, NAME_LABEL, REPO_ANNOTATION, WORKSPACE_PORT } from "./manifests.js";

// Hop-by-hop and length/encoding headers; fetch() re-frames bodies itself.
const DROP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"];
const RUNTIME_CLASS_RE = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;

export function gatewayConfig(env = process.env) {
  return {
    namespace: env.GATEWAY_NAMESPACE || "pi-ez-workspaces",
    image: env.WORKSPACE_IMAGE || "ghcr.io/bry-guy/pi-ez-web:latest",
    storage: env.WORKSPACE_STORAGE || "20Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS || null,
    envConfigMap: env.WORKSPACE_ENV_CONFIGMAP || null,
    imagePullSecret: env.WORKSPACE_IMAGE_PULL_SECRET || null,
    githubClientId: env.PI_WEB_GITHUB_CLIENT_ID || null,
    upstream: name => `http://ws-${name}.${env.GATEWAY_NAMESPACE || "pi-ez-workspaces"}.svc.cluster.local:${WORKSPACE_PORT}`,
  };
}

// One GitHub login for every workspace: the device flow runs here and the
// token is stored in a Secret that workspaces mount read-only.
export function githubSecretStore(kube, ns) {
  const path = `/api/v1/namespaces/${ns}/secrets/${GITHUB_SECRET}`;
  return {
    async save(auth) {
      const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: GITHUB_SECRET }, type: "Opaque",
        stringData: { "github-auth.json": JSON.stringify({ version: 1, ...auth }) } };
      let res = await kube.request("PUT", path, secret);
      if (res.status === 404) res = await kube.request("POST", `/api/v1/namespaces/${ns}/secrets`, secret);
      if (res.status >= 300) throw new Error(`kubernetes ${res.status}`);
    },
    async load() {
      const res = await kube.request("GET", path);
      if (res.status !== 200) return null;
      try { return JSON.parse(Buffer.from(res.body.data["github-auth.json"], "base64").toString("utf8")); } catch { return null; }
    },
    async remove() {
      const res = await kube.request("DELETE", path);
      if (res.status >= 300 && res.status !== 404) throw new Error(`kubernetes ${res.status}`);
    },
  };
}

class SecretGitHubClient extends GitHubClient {
  constructor(store, clientId) { super({ configOverride: { clientId, owner: null } }); this.store = store; this.pending = null; }
  // The flow manager calls saveToken synchronously; the Secret write is awaited by status/login polling.
  saveToken(auth) { this.pending = this.store.save(auth).catch(e => { console.error("pi-ez-gateway github save failed", e.message); throw e; }); }
}

export function createGateway({ kube, config = gatewayConfig(), fetchImpl = globalThis.fetch } = {}) {
  const ns = config.namespace;
  const store = githubSecretStore(kube, ns);
  const github = new SecretGitHubClient(store, config.githubClientId);
  const flows = new GitHubDeviceFlowManager(github);
  const apps = `/apis/apps/v1/namespaces/${ns}/deployments`;
  const core = kind => `/api/v1/namespaces/${ns}/${kind}`;
  const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);
  const app = new Hono();

  async function create(path, manifest) {
    const res = await kube.request("POST", path, manifest);
    if (res.status === 409 || (res.status >= 200 && res.status < 300)) return;
    throw Object.assign(new Error(res.body?.message || `kubernetes ${res.status}`), { status: 502 });
  }

  app.get("/healthz", c => c.json({ ok: true }));

  app.get("/api/gateway/github", async c => {
    await github.pending?.catch(() => {});
    const auth = await store.load();
    return c.json({ configured: !!config.githubClientId, authenticated: !!auth?.accessToken, account: auth?.account || null });
  });
  app.post("/api/gateway/github/device-login", async c => {
    try { return c.json({ flow: flows.view(await flows.start()) }, 202); }
    catch (e) { return c.json({ error: e.code || "github_login_failed" }, e.code === "github_flow_active" || e.code === "github_not_configured" ? 409 : 502); }
  });
  app.get("/api/gateway/github/device-login/:id", c => {
    try { return c.json({ flow: flows.view(flows.get(c.req.param("id"))) }); }
    catch { return c.json({ error: "no_such_github_flow" }, 404); }
  });
  app.post("/api/gateway/github/logout", async c => { await store.remove(); return c.json({ ok: true }); });

  app.get("/api/gateway/workspaces", async c => {
    const res = await kube.request("GET", `${apps}?labelSelector=${selector}`);
    if (res.status !== 200) return c.json({ error: "kubernetes_error" }, 502);
    return c.json({
      workspaces: (res.body.items || []).map(d => ({
        name: d.metadata.labels?.[NAME_LABEL],
        repository: d.metadata.annotations?.[REPO_ANNOTATION] || null,
        ready: (d.status?.readyReplicas || 0) > 0,
        runtimeClassName: d.spec?.template?.spec?.runtimeClassName || null,
      })),
    });
  });

  app.post("/api/gateway/workspaces", async c => {
    const body = await c.req.json().catch(() => null);
    const repository = typeof body?.repository === "string" ? body.repository.trim() : "";
    if (!repository || repository.length > 300 || /\s/.test(repository)) return c.json({ error: "invalid_repository" }, 400);
    const name = body.name ?? slugFromRepository(repository);
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    const runtimeClassName = body.runtimeClassName || null;
    if (runtimeClassName && !RUNTIME_CLASS_RE.test(runtimeClassName)) return c.json({ error: "invalid_runtime_class" }, 400);
    const secretName = body.secretName || null;
    if (secretName && !RUNTIME_CLASS_RE.test(secretName)) return c.json({ error: "invalid_secret_name" }, 400);

    const existing = await kube.request("GET", `${apps}/ws-${name}`);
    if (existing.status === 200 && existing.body?.metadata?.annotations?.[REPO_ANNOTATION] !== repository) {
      return c.json({ error: "workspace_name_taken", name }, 409);
    }
    // Per-project cluster grants are opt-in: an operator-created ws-<name> ServiceAccount.
    const sa = await kube.request("GET", `${core("serviceaccounts")}/ws-${name}`);
    const spec = { name, repository, image: config.image, serviceAccountName: sa.status === 200 ? `ws-${name}` : null,
      runtimeClassName, secretName, envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret };
    await create(core("persistentvolumeclaims"), pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName }));
    await create(core("services"), serviceManifest({ name, repository }));
    await create(apps, deploymentManifest(spec));
    return c.json({ name, url: `/w/${name}/` }, 201);
  });

  app.delete("/api/gateway/workspaces/:name", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    // The PVC holds unpushed work; keep it unless explicitly purged.
    const paths = [`${apps}/ws-${name}`, `${core("services")}/ws-${name}`, ...(c.req.query("purge") === "1" ? [`${core("persistentvolumeclaims")}/ws-${name}`] : [])];
    for (const path of paths) {
      const res = await kube.request("DELETE", path);
      if (res.status >= 300 && res.status !== 404) return c.json({ error: "kubernetes_error" }, 502);
    }
    return c.json({ ok: true });
  });

  app.get("/w/:name", c => validName(c.req.param("name")) ? c.redirect(`/w/${c.req.param("name")}/`, 308) : c.notFound());

  app.all("/w/:name/*", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.notFound();
    const prefix = `/w/${name}`;
    const raw = c.req.url;
    const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const target = config.upstream(name) + c.req.path.slice(prefix.length) + search;
    const headers = new Headers(c.req.raw.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    headers.set("x-forwarded-prefix", prefix);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let upstream;
    try {
      upstream = await fetchImpl(target, { method: c.req.method, headers, body: hasBody ? c.req.raw.body : undefined, duplex: "half", signal: c.req.raw.signal, redirect: "manual" });
    } catch {
      return c.json({ error: "workspace_unavailable", name }, 502);
    }
    const out = new Headers(upstream.headers);
    for (const h of DROP_HEADERS) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  app.get("/", c => c.html(PAGE));
  app.onError((e, c) => c.json({ error: e.status ? "kubernetes_error" : "internal_error", message: e.message }, e.status || 500));
  return app;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-ez workspaces</title><style>body{font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}li{margin:.4rem 0}input[type=text]{width:100%;padding:.4rem}</style></head>
<body><h1>Workspaces</h1><p id="gh" role="status">GitHub: checking…</p><ul id="list" aria-live="polite"><li>Loading…</li></ul>
<h2>Add repository</h2><form id="add"><label for="repo">Repository (owner/name or Git URL)</label><br><input id="repo" type="text" required>
<p><label><input id="kata" type="checkbox"> Needs containers (Docker/Compose in a Kata sandbox)</label></p><button>Create workspace</button> <span id="status" role="status"></span></form>
<script>
const list=document.getElementById("list"),status=document.getElementById("status");
async function load(){const r=await fetch("api/gateway/workspaces");const d=await r.json();list.replaceChildren(...(d.workspaces||[]).map(w=>{const li=document.createElement("li"),a=document.createElement("a");a.href="w/"+w.name+"/";a.textContent=w.name;li.append(a," — "+(w.repository||"")+(w.ready?"":" (starting…)"));return li;}));if(!list.children.length)list.innerHTML="<li>No workspaces yet.</li>";}
document.getElementById("add").onsubmit=async e=>{e.preventDefault();status.textContent="Creating…";const r=await fetch("api/gateway/workspaces",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({repository:document.getElementById("repo").value,...(document.getElementById("kata").checked?{runtimeClassName:"kata"}:{})})});const d=await r.json();status.textContent=r.ok?"Created "+d.name:"Error: "+d.error;load();};
const gh=document.getElementById("gh");
async function ghStatus(){const d=await (await fetch("api/gateway/github")).json();if(d.authenticated){gh.textContent="GitHub: signed in"+(d.account?.login?" as "+d.account.login:"")+" (shared with all workspaces) ";const b=document.createElement("button");b.textContent="Sign out";b.onclick=async()=>{await fetch("api/gateway/github/logout",{method:"POST"});ghStatus();};gh.append(b);}else{gh.textContent=d.configured?"GitHub: not signed in ":"GitHub: PI_WEB_GITHUB_CLIENT_ID not set";if(d.configured){const b=document.createElement("button");b.textContent="Sign in";b.onclick=ghLogin;gh.append(b);}}}
async function ghLogin(){const r=await fetch("api/gateway/github/device-login",{method:"POST"});const d=await r.json();if(!r.ok){gh.textContent="GitHub: "+d.error;return;}const f=d.flow;gh.textContent="Enter code "+f.userCode+" at ";const a=document.createElement("a");a.href=f.verificationUri;a.target="_blank";a.rel="noopener";a.textContent=f.verificationUri;gh.append(a);const t=setInterval(async()=>{const x=(await (await fetch("api/gateway/github/device-login/"+f.id)).json()).flow;if(!x||x.state!=="waiting_user"){clearInterval(t);if(x?.state!=="complete")gh.textContent="GitHub: "+(x?.error?.message||"login failed");else ghStatus();}},(f.intervalSeconds||5)*1000);}
ghStatus();load();setInterval(load,10000);
</script></body></html>`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3150);
  serve({ fetch: createGateway({ kube: inClusterKube() }).fetch, port });
  console.log(`pi-ez-gateway → http://localhost:${port}`);
}
