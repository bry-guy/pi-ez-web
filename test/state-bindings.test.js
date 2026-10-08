import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { get, home, setupServerFixture } from "./helpers/server-fixture.js";

setupServerFixture();

test("state migrates legacy bindings even without projects", async () => {
  const file = path.join(home, "bindings.json");
  fs.writeFileSync(file, JSON.stringify({ legacy: "/tmp/legacy-checkout" }));

  const response = await get("/api/state");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).projects, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    legacy: { projectId: null, workspacePath: "/tmp/legacy-checkout" },
  });
});
