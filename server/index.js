import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, loadConfig } from "./config.js";
import { hub } from "./events.js";
import { buildApi } from "./routes.js";
import { startSweeper } from "./lifecycle.js";
import { createSupervisor } from "./supervisor/index.js";
import { prune } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  ensureHome();
  const sup = createSupervisor(hub);
  const app = new Hono();
  app.route("/api", buildApi(sup));
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(here, "..", "public")) || "./public" }));
  return { app, sup };
}

export function startServer(port) {
  const cfg = loadConfig();
  for (const p of cfg.projects) prune(p.repoPath); // startup cleanup, no daemon
  const { app, sup } = createApp();
  const server = serve({ fetch: app.fetch, port: port ?? Number(process.env.PORT || cfg.port) });
  startSweeper(sup, hub);
  return { server, app, sup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = startServer();
  const addr = server.address();
  console.log(`pi-web-ui (${process.env.PI_WEB_MODE || "real"} mode) → http://localhost:${addr.port}`);
}
