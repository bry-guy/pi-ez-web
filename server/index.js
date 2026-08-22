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
import { publicError } from "./pi-configuration.js";
import { piWebStashes, prune } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_ONLY_CONFIG = Object.freeze({
  preview: true,
  productionData: true,
  apiBasePath: "/api",
  label: "Preview UI · production data",
});

function uiOnlyEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.PI_WEB_UI_ONLY || "").trim().toLowerCase());
}

function addStaticRoutes(app, { uiOnly }) {
  app.get("/ui-health", c => c.json({ ok: true, mode: uiOnly ? "ui-only" : "full" }));
  app.get("/ui-config.json", c => {
    c.header("cache-control", "no-store");
    return c.json(uiOnly ? UI_ONLY_CONFIG : { ...UI_ONLY_CONFIG, preview: false, productionData: false, label: null });
  });
  // PWA clients must always revalidate the shell and service worker after a
  // rollout. The service worker supplies offline fallback itself; HTTP caches
  // should never pin an older UI or worker in Safari.
  app.use("/*", async (c, next) => {
    c.header("cache-control", "no-cache");
    await next();
  });
  const root = path.join(here, "..");
  // Expose only the two browser assets needed for rich, sanitized Markdown;
  // do not make node_modules generally web-accessible.
  app.get("/vendor/marked.umd.js", serveStatic({ root, path: "node_modules/marked/lib/marked.umd.js" }));
  app.get("/vendor/dompurify.min.js", serveStatic({ root, path: "node_modules/dompurify/dist/purify.min.js" }));
  app.use("/*", serveStatic({ root: path.join(root, "public") }));
}

export function createApp({ syncCoordinator = null, uiOnly = uiOnlyEnabled() } = {}) {
  const app = new Hono();
  let sup = null;
  app.onError((error, c) => {
    const requestId = c.get("requestId") || randomUUID();
    console.error("pi-ez-web request failed", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      stack: publicError(error instanceof Error ? error.stack : String(error)),
    });
    c.header("x-request-id", requestId);
    return c.json({ error: "internal_error", requestId }, 500);
  });
  if (!uiOnly) {
    ensureHome();
    sup = createSupervisor(hub);
    app.use("/api/*", async (c, next) => {
      const requestId = randomUUID();
      c.set("requestId", requestId);
      c.header("x-request-id", requestId);
      await next();
    });
    app.route("/api", buildApi(sup, { syncCoordinator }));
  }
  addStaticRoutes(app, { uiOnly });
  return { app, sup };
}

export function startServer(port, options = {}) {
  const uiOnly = options.uiOnly ?? uiOnlyEnabled();
  let cfg = null;
  if (!uiOnly) {
    cfg = loadConfig();
    for (const p of cfg.projects) {
      prune(p.repoPath); // startup cleanup, no daemon
      const stranded = piWebStashes(p.repoPath);
      if (stranded.length) console.warn(`pi-web-ui: stranded fork stash(es) in ${p.repoPath}: ${stranded.join(", ")}`);
    }
  }
  const { app, sup } = createApp({ ...options, uiOnly });
  const server = serve({ fetch: app.fetch, port: port ?? Number(process.env.PORT || cfg?.port || 3141) });
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
