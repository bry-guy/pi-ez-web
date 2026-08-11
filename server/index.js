import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, loadConfig } from "./config.js";
import { hub } from "./events.js";
import { buildApi } from "./routes.js";
import { createSupervisor } from "./supervisor/index.js";
import { piWebStashes, prune } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  ensureHome();
  const sup = createSupervisor(hub);
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });
  app.onError((error, c) => {
    const requestId = c.get("requestId") || randomUUID();
    console.error("pi-ez-web request failed", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      stack: error instanceof Error ? error.stack : String(error),
    });
    c.header("x-request-id", requestId);
    return c.json({ error: "internal_error", requestId }, 500);
  });
  app.route("/api", buildApi(sup));
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(here, "..", "public")) || "./public" }));
  return { app, sup };
}

export function startServer(port) {
  const cfg = loadConfig();
  for (const p of cfg.projects) {
    prune(p.repoPath); // startup cleanup, no daemon
    const stranded = piWebStashes(p.repoPath);
    if (stranded.length) console.warn(`pi-web-ui: stranded fork stash(es) in ${p.repoPath}: ${stranded.join(", ")}`);
  }
  const { app, sup } = createApp();
  const server = serve({ fetch: app.fetch, port: port ?? Number(process.env.PORT || cfg.port) });
  return { server, app, sup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = startServer();
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`pi-web-ui: port ${e.port} is already in use (another instance running?). Set PORT to change it.`);
      process.exit(1);
    }
    throw e;
  });
  const announce = () => {
    const addr = server.address();
    if (addr) console.log(`pi-web-ui (${process.env.PI_WEB_MODE || "real"} mode) → http://localhost:${addr.port}`);
  };
  if (server.listening) announce();
  else server.on("listening", announce);
}
