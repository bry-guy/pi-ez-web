import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appHome, loadConfig, saveConfig } from "../server/config.js";
import { normalizeProjectEnvironment, resolveProjectEnvironment } from "../server/project-environment.js";

let tmp;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-project-environment-"));
  process.env.PI_WEB_HOME = tmp;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("project environment mappings are names-only and strictly validated", () => {
  assert.equal(normalizeProjectEnvironment(undefined), undefined);
  assert.deepEqual(normalizeProjectEnvironment({}), {});

  const valid = Object.fromEntries([
    ["__proto__", "SOURCE_VALUE"],
    ["constructor", "EMPTY_VALUE"],
    ["DESTINATION", "SOURCE"],
  ]);
  const normalized = normalizeProjectEnvironment(Object.freeze(valid));
  assert.deepEqual(normalized, valid);
  assert.notStrictEqual(normalized, valid);
  assert.equal(Object.hasOwn(normalized, "__proto__"), true);
  assert.equal(Object.hasOwn(normalized, "constructor"), true);

  for (const invalid of [
    null,
    [],
    "mapping",
    { DESTINATION: 1 },
    { "bad-name": "SOURCE" },
    { DESTINATION: "bad-source" },
    { " DESTINATION": "SOURCE" },
    { DESTINATION: " SOURCE" },
    { "DESTINATION\n": "SOURCE" },
    { "DESTINATION\r": "SOURCE" },
    { DESTINATION: "SOURCE\n" },
    { DESTINATION: "SOURCE\r" },
  ]) {
    assert.throws(() => normalizeProjectEnvironment(invalid), error => {
      assert.equal(error.code, "invalid_project_environment");
      assert.equal(error.message, "Project environment mapping is invalid.");
      return true;
    });
  }

  assert.throws(() => normalizeProjectEnvironment({ DESTINATION: "SECRET-VALUE" }), error => {
    assert.equal(error.code, "invalid_project_environment");
    assert.doesNotMatch(String(error), /SECRET-VALUE/);
    return true;
  });
});

test("project environment resolution distinguishes missing, empty, own, and inherited sources", () => {
  const mapping = Object.freeze(Object.fromEntries([
    ["__proto__", "TOKEN_SOURCE"],
    ["constructor", "EMPTY_SOURCE"],
    ["DESTINATION", "SOURCE"],
  ]));
  const source = Object.freeze({ TOKEN_SOURCE: "token-sentinel", EMPTY_SOURCE: "", SOURCE: "value" });
  const snapshot = () => createHash("sha256")
    .update(JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)))
    .digest("hex");
  const beforeProcess = snapshot();
  const resolved = resolveProjectEnvironment(mapping, source);

  assert.deepEqual(resolved, Object.fromEntries([
    ["__proto__", "token-sentinel"],
    ["constructor", ""],
    ["DESTINATION", "value"],
  ]));
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype);
  assert.equal(Object.hasOwn(resolved, "__proto__"), true);
  assert.equal(Object.hasOwn(resolved, "constructor"), true);
  assert.deepEqual(mapping, Object.fromEntries([
    ["__proto__", "TOKEN_SOURCE"],
    ["constructor", "EMPTY_SOURCE"],
    ["DESTINATION", "SOURCE"],
  ]));
  resolved.DESTINATION = "changed";
  assert.equal(source.SOURCE, "value");

  const specialSource = Object.freeze(Object.fromEntries([
    ["__proto__", "proto-value"],
    ["constructor", "constructor-value"],
  ]));
  assert.deepEqual(resolveProjectEnvironment(Object.fromEntries([
    ["PROTO_DESTINATION", "__proto__"],
    ["CONSTRUCTOR_DESTINATION", "constructor"],
  ]), specialSource), { PROTO_DESTINATION: "proto-value", CONSTRUCTOR_DESTINATION: "constructor-value" });

  const inheritedMapping = Object.create({ INHERITED_DESTINATION: "SOURCE" });
  inheritedMapping.OWN_DESTINATION = "SOURCE";
  assert.deepEqual(normalizeProjectEnvironment(inheritedMapping), { OWN_DESTINATION: "SOURCE" });

  assert.deepEqual(resolveProjectEnvironment(undefined), {});
  assert.deepEqual(resolveProjectEnvironment({}), {});
  const second = resolveProjectEnvironment({ OTHER: "OTHER_SOURCE" }, { OTHER_SOURCE: "other" });
  assert.deepEqual(second, { OTHER: "other" });
  assert.equal(resolved.OTHER, undefined);

  const repeatMapping = { DESTINATION: "SOURCE" };
  const repeatSource = { SOURCE: "value" };
  const first = resolveProjectEnvironment(repeatMapping, repeatSource);
  const repeat = resolveProjectEnvironment(repeatMapping, repeatSource);
  assert.notStrictEqual(first, repeat);
  first.DESTINATION = "changed";
  assert.equal(repeat.DESTINATION, "value");

  const inherited = Object.create({ INHERITED: "inherited-value" });
  assert.throws(() => resolveProjectEnvironment({ DESTINATION: "INHERITED" }, inherited), error => {
    assert.equal(error.code, "project_environment_source_missing");
    assert.equal(error.message, "Project environment source is missing.");
    assert.doesNotMatch(String(error), /inherited-value|INHERITED/);
    return true;
  });

  const undefinedSource = { UNDEFINED_SOURCE: undefined };
  assert.throws(() => resolveProjectEnvironment({ DESTINATION: "UNDEFINED_SOURCE" }, undefinedSource), error => {
    assert.equal(error.code, "project_environment_source_missing");
    assert.doesNotMatch(String(error), /UNDEFINED_SOURCE/);
    return true;
  });

  const mixed = Object.freeze(Object.fromEntries([
    ["FIRST_DESTINATION", "FIRST_SOURCE"],
    ["MISSING_DESTINATION", "MISSING_SOURCE"],
  ]));
  assert.throws(() => resolveProjectEnvironment(mixed, { FIRST_SOURCE: "first-value" }), error => {
    assert.equal(error.code, "project_environment_source_missing");
    assert.doesNotMatch(String(error), /MISSING_SOURCE|first-value/);
    return true;
  });

  assert.equal(snapshot(), beforeProcess);
});

test("project configuration persists environment source names and rejects invalid mappings", () => {
  const configFile = path.join(appHome(), "config.json");
  const environment = {
    OP_SERVICE_ACCOUNT_TOKEN: "INFRA_ONEPASSWORD_TOKEN",
    GHCR_READ_TOKEN: "INFRA_GHCR_TOKEN",
  };
  saveConfig({ projects: [
    { id: "omitted", name: "omitted", repoPath: "/tmp/omitted" },
    { id: "empty", name: "empty", repoPath: "/tmp/empty", environment: {} },
    { id: "infra", name: "infra", repoPath: "/tmp/infra", environment },
  ] });
  const saved = fs.readFileSync(configFile, "utf8");
  assert.doesNotMatch(saved, /credential-value-sentinel|ghcr-value-sentinel/);
  assert.equal(Object.hasOwn(JSON.parse(saved).projects[0], "environment"), false);

  const loaded = loadConfig();
  assert.equal(Object.hasOwn(loaded.projects[0], "environment"), false);
  assert.deepEqual(loaded.projects[1].environment, {});
  assert.deepEqual(loaded.projects[2].environment, environment);

  const resolved = resolveProjectEnvironment(loaded.projects[2].environment, {
    INFRA_ONEPASSWORD_TOKEN: "credential-value-sentinel",
    INFRA_GHCR_TOKEN: "ghcr-value-sentinel",
  });
  assert.deepEqual(resolved, {
    OP_SERVICE_ACCOUNT_TOKEN: "credential-value-sentinel",
    GHCR_READ_TOKEN: "ghcr-value-sentinel",
  });
  assert.deepEqual(environment, {
    OP_SERVICE_ACCOUNT_TOKEN: "INFRA_ONEPASSWORD_TOKEN",
    GHCR_READ_TOKEN: "INFRA_GHCR_TOKEN",
  });

  saveConfig(loaded);
  const roundTripped = fs.readFileSync(configFile, "utf8");
  assert.doesNotMatch(roundTripped, /credential-value-sentinel|ghcr-value-sentinel/);
  const roundTrippedValue = JSON.parse(roundTripped);
  assert.equal(Object.hasOwn(roundTrippedValue.projects[0], "environment"), false);
  assert.deepEqual(roundTrippedValue.projects[1].environment, {});
  assert.deepEqual(roundTrippedValue.projects[2].environment, environment);

  const invalid = JSON.stringify({ projects: [{ name: "infra", environment: { TOKEN: "SECRET-VALUE" } }] });
  fs.writeFileSync(configFile, invalid);
  assert.throws(() => loadConfig(), error => {
    assert.equal(error.code, "invalid_project_environment");
    assert.equal(error.message, "Project environment mapping is invalid.");
    assert.doesNotMatch(String(error), /SECRET-VALUE/);
    return true;
  });
  assert.equal(fs.readFileSync(configFile, "utf8"), invalid);
  fs.rmSync(configFile, { force: true });
});
