import test from "node:test";
import assert from "node:assert/strict";
import { seedRequest, seedRepository } from "../server/seed.js";

test("seedRequest maps GitHub repositories and plain git URLs", () => {
  assert.deepEqual(seedRequest("https://github.com/bry-guy/srvivor.git"), { source: "github", fullName: "bry-guy/srvivor" });
  assert.deepEqual(seedRequest("bry-guy/infra"), { source: "github", fullName: "bry-guy/infra" });
  assert.deepEqual(seedRequest("https://git.example.com/x.git"), { source: "git-url", url: "https://git.example.com/x.git" });
  assert.equal(seedRequest(" "), null);
});

function fakeApp(responses) {
  const calls = [];
  return {
    calls,
    request: async (url, init) => {
      calls.push(url);
      const [status, body] = url === "/api/projects" ? responses.shift() : [200, {}];
      return new Response(JSON.stringify(body), { status });
    },
  };
}

test("seed retries until GitHub login, then runs setup once", async () => {
  const app = fakeApp([[401, { error: "github_auth_required" }], [200, { id: "p1", sessionId: "s1", setupNeeded: true }]]);
  const result = await seedRepository(app, "bry-guy/srvivor", { setTimer: fn => fn() });
  assert.deepEqual(result, { status: "connected", projectId: "p1" });
  assert.deepEqual(app.calls, ["/api/projects", "/api/projects", "/api/sessions/s1/hooks/setup"]);
});

test("seed is idempotent across restarts and stops on permanent errors", async () => {
  assert.equal((await seedRepository(fakeApp([[409, { error: "project_exists" }]]), "a/b")).status, "exists");
  assert.equal((await seedRepository(fakeApp([[400, { error: "invalid_git_url" }]]), "a/b")).status, "failed");
});
