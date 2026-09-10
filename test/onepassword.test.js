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
    const result = await connect(" op_private-token ", { home, createClient: clientFactory(seen) });
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
        && error.message === "1Password connection failed."
        && !error.message.includes("op_bad-token"),
    );
    assert.equal(fs.readFileSync(credentialPath(home), "utf8").trim(), "op_good-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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

test("validation rejects a client that never resolves", async () => {
  const home = tempHome();
  try {
    await assert.rejects(
      () => connect("op_private-token", { home, timeoutMs: 10, createClient: () => new Promise(() => {}) }),
      error => error.code === "onepassword_auth_failed",
    );
    assert.equal(fs.existsSync(credentialPath(home)), false);
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
