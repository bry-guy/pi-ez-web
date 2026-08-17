import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appHome, githubConfig, loadBindings, loadConfig, normalizeHooks, normalizePiConfig, projectMode, repositorySource, saveBindings, saveConfig, worktreeRoot } from "../server/config.js";

let tmp;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-config-"));
  process.env.PI_WEB_HOME = tmp;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("worktree root defaults beside Pi and respects an explicit override", () => {
  assert.equal(worktreeRoot({}), path.join(os.homedir(), ".pi", "worktrees"));
  assert.equal(worktreeRoot({ worktreeRoot: "/x" }), "/x");
});

test("project hooks normalize commands and allow explicit removal", () => {
  assert.deepEqual(normalizeHooks({ setup: " mise install ", check: null, "bad name": "ignored", empty: "  " }), { setup: "mise install", check: null });
});

test("named project hook sets normalize deployment defaults", () => {
  saveConfig({ projectHookSets: { infra: { check: " mise run check ", "bad name": "ignored" }, "": { setup: "ignored" } } });
  assert.deepEqual(loadConfig().projectHookSets, { infra: { check: "mise run check" } });
});

test("Pi resource config normalizes a profile and unique package/extension sources", () => {
  assert.deepEqual(normalizePiConfig({
    profile: " https://github.com/bry-guy/dotfiles ",
    packages: ["npm:context-mode", "npm:context-mode", ""],
    extensions: [" ./extensions/test.ts "],
  }), {
    profile: "https://github.com/bry-guy/dotfiles",
    packages: ["npm:context-mode"],
    extensions: ["./extensions/test.ts"],
  });
  assert.throws(() => normalizePiConfig({ packages: "nope" }, { strict: true }), error => error.code === "invalid_pi_configuration");
});

test("project modes default to manual and preserve only valid values", () => {
  assert.equal(projectMode({}), "manual");
  assert.equal(projectMode({ mode: "auto" }), "auto");
  assert.equal(projectMode({ mode: "invalid" }), "manual");
});

test("repository source config merges nested defaults and validates the default", () => {
  saveConfig({ repositorySources: { default: "github", github: { owner: "bry-guy" } } });
  const cfg = loadConfig();
  assert.equal(repositorySource(cfg), "github");
  assert.equal(cfg.repositorySources.github.owner, "bry-guy");
  assert.equal(cfg.repositorySources.github.clientId, null);

  saveConfig({ repositorySources: { default: "invalid" } });
  assert.equal(repositorySource(loadConfig()), "local");
});

test("environment overrides repository source settings", () => {
  const previous = {
    source: process.env.PI_WEB_REPOSITORY_SOURCE,
    client: process.env.PI_WEB_GITHUB_CLIENT_ID,
    owner: process.env.PI_WEB_GITHUB_OWNER,
  };
  process.env.PI_WEB_REPOSITORY_SOURCE = "git-url";
  process.env.PI_WEB_GITHUB_CLIENT_ID = "client-from-env";
  process.env.PI_WEB_GITHUB_OWNER = "owner-from-env";
  try {
    assert.equal(repositorySource({ repositorySources: { default: "local" } }), "git-url");
    assert.deepEqual(githubConfig({ repositorySources: { github: { clientId: "config-client", owner: "config-owner" } } }), { clientId: "client-from-env", owner: "owner-from-env" });
  } finally {
    for (const [key, value] of Object.entries({ PI_WEB_REPOSITORY_SOURCE: previous.source, PI_WEB_GITHUB_CLIENT_ID: previous.client, PI_WEB_GITHUB_OWNER: previous.owner })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("bindings v1 strings migrate to v2 objects and round-trip", () => {
  fs.mkdirSync(appHome(), { recursive: true });
  const file = path.join(appHome(), "bindings.json");
  fs.writeFileSync(file, JSON.stringify({ s1: "/tmp/old-worktree" }));
  assert.deepEqual(loadBindings(), { s1: { branch: null, workspacePath: "/tmp/old-worktree" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { s1: { branch: null, workspacePath: "/tmp/old-worktree" } });

  saveBindings({ s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
  assert.deepEqual(loadBindings(), { s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
});
