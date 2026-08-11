import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthFlowManager } from "../server/auth-flows.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function supervisor() {
  return {
    async listProviders() {
      return [{
        id: "test-provider",
        authMethods: [{ id: "oauth", label: "Test OAuth" }],
      }];
    },
    async loginProvider(_providerId, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://example.test/login?state=not-a-secret", instructions: "Open the test page." });
      const value = await interaction.prompt({ type: "secret", message: "Enter test value" });
      assert.equal(value, "accepted");
    },
  };
}

test("auth flow bridges prompts and never exposes submitted secrets", async () => {
  const manager = new AuthFlowManager(supervisor());
  const flow = await manager.start("test-provider", "oauth");
  await wait(5);
  let view = flow.view();
  assert.equal(view.state, "waiting_input");
  assert.equal(view.prompt.type, "secret");
  assert.equal(view.notification.type, "auth_url");
  assert.doesNotMatch(JSON.stringify(view), /accepted/);

  flow.submit(view.prompt.id, "accepted");
  await wait(10);
  view = flow.view();
  assert.equal(view.state, "complete");
  assert.doesNotMatch(JSON.stringify(view), /accepted/);
});

test("auth flow rejects stale prompts and only allows one active flow", async () => {
  const manager = new AuthFlowManager(supervisor());
  const flow = await manager.start("test-provider", "oauth");
  await wait(5);
  assert.throws(() => flow.submit("p_stale", "x"), error => error.code === "stale_auth_prompt");
  await assert.rejects(() => manager.start("test-provider", "oauth"), error => error.code === "auth_flow_active");
  flow.cancel();
  await wait(5);
  assert.equal(flow.view().state, "cancelled");
});

test("auth flow validates select values", async () => {
  const fake = {
    async listProviders() { return [{ id: "select-provider", authMethods: [{ id: "oauth" }] }]; },
    async loginProvider(_id, _type, interaction) {
      const value = await interaction.prompt({ type: "select", message: "Choose", options: [{ id: "one", label: "One" }] });
      assert.equal(value, "one");
    },
  };
  const manager = new AuthFlowManager(fake);
  const flow = await manager.start("select-provider", "oauth");
  await wait(5);
  assert.throws(() => flow.submit(flow.view().prompt.id, "two"), error => error.code === "invalid_auth_option");
  flow.submit(flow.view().prompt.id, "one");
  await wait(5);
  assert.equal(flow.view().state, "complete");
});
