import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
beforeEach(async () => { fixture = await createIsolatedServerFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test("merge from a checkout session is nothing_to_merge", async () => {
  const sessionId = await fixture.createBoundSession();
  const response = await fixture.post(`/api/sessions/${sessionId}/merge-local`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "nothing_to_merge");
  await fixture.post(`/api/sessions/${sessionId}/close`);
});
