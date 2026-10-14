import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writeAtomic(file, data) {
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// Workers as child processes of workspaced in the same container (Compose).
// One trust boundary: workers share HOME and tools; only state dirs differ.
export function localProvider({ root, spawnImpl = spawn, server = SERVER } = {}) {
  mkdirSync(root, { recursive: true });
  const registry = path.join(root, "workspaces.json");
  const authFile = path.join(root, "github-auth.json");
  const modelAuthFile = path.join(root, "model-auth.json");
  const procs = new Map();
  const read = () => { try { return JSON.parse(readFileSync(registry, "utf8")); } catch { return {}; } };

  async function start(name, { repository }) {
    if (procs.get(name)?.exitCode === null) return;
    const dir = path.join(root, name);
    const port = await freePort();
    const child = spawnImpl(process.execPath, [server], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port), PI_WEB_MODE: process.env.PI_WEB_MODE || "real",
        PI_WEB_HOME: path.join(dir, "pi-ez-web"), PI_CODING_AGENT_DIR: path.join(dir, "pi-ez-agent"),
        PI_WEB_REPOS_ROOT: path.join(dir, "repos"), PI_WEB_GITHUB_AUTH_FILE: authFile, PI_WEB_MODEL_AUTH_FILE: modelAuthFile,
        WORKSPACED_TOKEN: "" },
    });
    child.port = port;
    procs.set(name, child);
  }

  return {
    async init() { for (const [name, w] of Object.entries(read())) await start(name, w); },
    async list() {
      return Object.entries(read()).map(([name, w]) => ({ name, repository: w.repository, ready: procs.get(name)?.exitCode === null, containers: false }));
    },
    async create({ name, repository }) {
      const all = read();
      if (all[name] && all[name].repository !== repository) throw Object.assign(new Error("workspace name taken"), { status: 409, code: "workspace_name_taken" });
      all[name] = { repository };
      writeAtomic(registry, JSON.stringify(all, null, 2));
      await start(name, all[name]);
    },
    async remove(name, { purge = false } = {}) {
      procs.get(name)?.kill("SIGTERM");
      procs.delete(name);
      const all = read();
      delete all[name];
      writeAtomic(registry, JSON.stringify(all, null, 2));
      if (purge) rmSync(path.join(root, name), { recursive: true, force: true });
    },
    upstream(name) {
      const child = procs.get(name);
      return child ? `http://127.0.0.1:${child.port}` : null;
    },
    async setGitHubAuth(auth) {
      if (auth) writeAtomic(authFile, JSON.stringify(auth));
      else rmSync(authFile, { force: true });
    },
    async setModelAuth(content) {
      if (content === null) rmSync(modelAuthFile, { force: true });
      else writeAtomic(modelAuthFile, content);
    },
    stop() { for (const child of procs.values()) child.kill("SIGTERM"); },
  };
}
