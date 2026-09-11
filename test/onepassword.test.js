import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { connect, credentialPath, disconnect, status } from "../server/onepassword.js";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piweb-op-"));
}

function clientFactory(seen, error = null) {
  return async options => {
    seen.push(options.auth);
    if (error) throw new Error(error);
    return {
      vaults: { list: async () => [{ id: "vault" }] },
      get secrets() { throw new Error("secret values must not be read"); },
    };
  };
}

test("validates and stores a 1Password service-account token privately", async () => {
  const home = tempHome();
  const seen = [];
  try {
    const result = await connect(" op_private-token ", {
      home,
      loadSdk: async () => ({ createClient: clientFactory(seen) }),
    });
    const file = credentialPath(home);
    assert.deepEqual(result, { connected: true });
    assert.deepEqual(seen, ["op_private-token"]);
    assert.equal(fs.readFileSync(file, "utf8").trim(), "op_private-token");
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid credentials do not replace an existing connection or expose the token", async () => {
  const home = tempHome();
  try {
    await connect("op_good-token", { home, createClient: clientFactory([]) });
    await assert.rejects(
      () => connect("op_bad-token", { home, createClient: clientFactory([], "token op_bad-token rejected") }),
      error => error.code === "onepassword_auth_failed"
        && error.message === "1Password authentication failed."
        && !error.message.includes("op_bad-token"),
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("classifies SDK failures safely without replacing an existing connection", async () => {
  const failures = [
    { error: Object.assign(new Error("too many requests"), { name: "RateLimitExceededError" }), code: "onepassword_rate_limited", message: "1Password is rate limited. Try again later.", leak: "too many requests" },
    { error: Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }), code: "onepassword_service_unavailable", message: "1Password service is unavailable. Try again later.", leak: "fetch failed" },
    { error: Object.assign(new Error("request failed"), { cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }) }), code: "onepassword_service_unavailable", message: "1Password service is unavailable. Try again later.", leak: "DNS lookup" },
    { error: Object.assign(new Error("wasm trap"), { name: "RuntimeError" }), code: "onepassword_sdk_unavailable", message: "1Password SDK is unavailable on this server.", leak: "wasm trap" },
    { error: Object.assign(new Error("raw timeout detail"), { code: "onepassword_validation_timeout" }), code: "onepassword_validation_timeout", message: "1Password validation timed out.", leak: "raw timeout" },
    { error: Object.assign(new Error("raw SDK detail"), { code: "onepassword_sdk_unavailable" }), code: "onepassword_sdk_unavailable", message: "1Password SDK is unavailable on this server.", leak: "raw SDK" },
  ];
  for (const failure of failures) {
    const home = tempHome();
    try {
      await connect("op_good-token", { home, createClient: clientFactory([]) });
      await assert.rejects(
        () => connect("op_private-token", { home, createClient: async () => { throw failure.error; } }),
        error => error.code === failure.code
          && error.message === failure.message
          && !error.message.includes(failure.leak),
      );
      assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("empty credentials are rejected before validation", async () => {
  const home = tempHome();
  let called = false;
  try {
    await assert.rejects(
      () => connect("  ", { home, createClient: async () => { called = true; } }),
      error => error.code === "onepassword_token_required",
    );
    assert.equal(called, false);
    assert.deepEqual(status(home), { connected: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("client-creation timeouts do not replace an existing connection", async () => {
  const home = tempHome();
  try {
    await connect("op_good-token", { home, createClient: clientFactory([]) });
    await assert.rejects(
      () => connect("op_private-token", { home, timeoutMs: 10, createClient: () => new Promise(() => {}) }),
      error => error.code === "onepassword_validation_timeout"
        && error.message === "1Password validation timed out.",
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("uses the installed SDK named createClient export", async () => {
  const sdk = await import("@1password/sdk");
  assert.equal(typeof sdk.createClient, "function");
});

test("accepts a legacy default SDK export", async () => {
  const home = tempHome();
  try {
    const result = await connect("op_default-token", {
      home,
      loadSdk: async () => ({ default: { createClient: clientFactory([]) } }),
    });
    assert.deepEqual(result, { connected: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rejects an unavailable SDK without replacing an existing connection", async () => {
  for (const loadSdk of [async () => ({}), async () => { throw new Error("SDK loader detail"); }]) {
    const home = tempHome();
    try {
      await connect("op_good-token", { home, createClient: clientFactory([]) });
      await assert.rejects(
        () => connect("op_new-token", { home, loadSdk }),
        error => error.code === "onepassword_sdk_unavailable"
          && error.message === "1Password SDK is unavailable on this server."
          && !error.message.includes("op_new-token"),
      );
      assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("rejects a malformed SDK client without replacing an existing connection", async () => {
  const home = tempHome();
  try {
    await connect("op_good-token", { home, createClient: clientFactory([]) });
    await assert.rejects(
      () => connect("op_new-token", { home, createClient: async () => ({}) }),
      error => error.code === "onepassword_sdk_unavailable"
        && error.message === "1Password SDK is unavailable on this server.",
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("vault-validation timeouts do not replace an existing connection", async () => {
  const home = tempHome();
  try {
    await connect("op_good-token", { home, createClient: clientFactory([]) });
    await assert.rejects(
      () => connect("op_private-token", {
        home,
        timeoutMs: 10,
        createClient: async () => ({ vaults: { list: () => new Promise(() => {}) } }),
      }),
      error => error.code === "onepassword_validation_timeout",
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("successful reconnect replaces the stored credential after validation", async () => {
  const home = tempHome();
  try {
    await connect("op_first-token", { home, createClient: clientFactory([]) });
    const result = await connect("op_second-token", { home, createClient: clientFactory([]) });
    assert.deepEqual(result, { connected: true });
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_second-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("storage failures do not replace an existing connection", async () => {
  const home = tempHome();
  try {
    await connect("op_good-token", { home, createClient: clientFactory([]) });
    await assert.rejects(
      () => connect("op_new-token", {
        home,
        createClient: clientFactory([]),
        writeCredential: () => { throw new Error("disk detail"); },
      }),
      error => error.code === "onepassword_store_failed"
        && error.message === "1Password connection could not be stored.",
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("disconnect removes the stored credential without returning it", async () => {
  const home = tempHome();
  try {
    await connect("op_private-token", { home, createClient: clientFactory([]) });
    assert.deepEqual(disconnect(home), { connected: false });
    assert.equal(fs.existsSync(credentialPath(home)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
