import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let base;
let server;

before(async () => {
  const { startServer } = await import("../server/index.js");
  ({ server } = startServer(0, { uiOnly: true }));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

test("ui-only mode serves an independent health endpoint and preview config", async () => {
  const healthResponse = await fetch(`${base}/ui-health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, mode: "ui-only" });

  const configResponse = await fetch(`${base}/ui-config.json`);
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await configResponse.json(), {
    preview: true,
    productionData: true,
    apiBasePath: "/api",
    label: "Preview UI · production data",
  });
});

test("ui-only mode serves the shell without constructing the application API", async () => {
  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<pi-app>/);

  const api = await fetch(`${base}/api/health`);
  assert.equal(api.status, 404);
});
