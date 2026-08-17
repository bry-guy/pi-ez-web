import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "../server/config.js";
import { PiConfiguration, githubProfileSettingsUrl, recoverIncompleteGitPackages } from "../server/pi-configuration.js";

let tmp;
let previousWebHome;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-profile-"));
  previousWebHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = path.join(tmp, "web");
  fs.mkdirSync(process.env.PI_WEB_HOME, { recursive: true });
});

after(() => {
  if (previousWebHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousWebHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GitHub profile references support repository and blob URLs", () => {
  assert.equal(
    githubProfileSettingsUrl("https://github.com/bry-guy/dotfiles"),
    "https://raw.githubusercontent.com/bry-guy/dotfiles/HEAD/.pi/agent/settings.json",
  );
  assert.equal(
    githubProfileSettingsUrl("https://github.com/bry-guy/dotfiles/blob/main/.pi/profiles/rpiv/settings.json"),
    "https://raw.githubusercontent.com/bry-guy/dotfiles/main/.pi/profiles/rpiv/settings.json",
  );
});

test("recovery removes only incomplete explicitly configured Git packages", () => {
  const agentDir = path.join(tmp, "recover-agent");
  const bad = path.join(agentDir, "git", "github.com", "example", "bad");
  const good = path.join(agentDir, "git", "github.com", "example", "good");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "partial.txt"), "partial");
  fs.mkdirSync(path.join(good, ".git"), { recursive: true });

  const recovered = recoverIncompleteGitPackages(agentDir, {
    packages: ["git:github.com/example/bad", "git:github.com/example/good", "npm:untouched"],
  });

  assert.deepEqual(recovered, [bad]);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(good), true);
});

test("a local profile overlays Pi settings, resolves resources, and keeps project overrides", async () => {
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  const profileDir = path.join(tmp, "profile");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:base-package"],
    quietStartup: false,
  }));
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    compaction: { reserveTokens: 333 },
  }));
  fs.writeFileSync(path.join(profileDir, "settings.json"), JSON.stringify({
    packages: ["npm:profile-package"],
    extensions: ["./extension.ts"],
    defaultThinkingLevel: "high",
    sessionDir: "/must/not/move/web/sessions",
    compaction: { reserveTokens: 222, keepRecentTokens: 111 },
  }));

  saveConfig({
    pi: {
      profile: profileDir,
      packages: ["npm:extra-package"],
      extensions: ["./web-extension.ts"],
    },
  });

  const configuration = new PiConfiguration();
  const { settingsManager } = await configuration.createSettingsManager(cwd, agentDir, SettingsManager);
  assert.deepEqual(settingsManager.getGlobalSettings().packages, ["npm:profile-package", "npm:extra-package"]);
  assert.deepEqual(settingsManager.getNpmCommand(), ["/usr/local/bin/npm", "--legacy-peer-deps", "--omit=dev"]);
  assert.deepEqual(settingsManager.getGlobalSettings().extensions, [
    path.join(profileDir, "extension.ts"),
    path.join(process.env.PI_WEB_HOME, "web-extension.ts"),
  ]);
  assert.equal(settingsManager.getDefaultThinkingLevel(), "high");
  assert.deepEqual(settingsManager.getCompactionSettings(), {
    enabled: true,
    reserveTokens: 333,
    keepRecentTokens: 111,
  });
  assert.equal(settingsManager.getSessionDir(), undefined);

  const state = await configuration.state();
  assert.equal(state.profile.status, "loaded");
  assert.equal(state.config.profile, profileDir);
});

test("an external profile loads declarative package sources and ignores its machine-local paths", async () => {
  let requested;
  const configuration = new PiConfiguration({
    fetchImpl: async url => {
      requested = url;
      return new Response(JSON.stringify({
        packages: ["npm:context-mode"],
        extensions: ["/Users/example/private-extension.ts"],
        defaultThinkingLevel: "xhigh",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const pi = {
    profile: "https://github.com/bry-guy/dotfiles",
    packages: [],
    extensions: [],
  };
  const resolved = await configuration.resolve(pi);
  assert.equal(requested, "https://raw.githubusercontent.com/bry-guy/dotfiles/HEAD/.pi/agent/settings.json");
  assert.equal(resolved.profile.status, "loaded");
  assert.deepEqual(resolved.settings.packages, ["npm:context-mode"]);
  assert.deepEqual(resolved.settings.extensions, []);
  assert.match(resolved.warnings[0], /Ignored remote profile extension path/);

  configuration.fetchImpl = async () => { throw new Error("offline"); };
  configuration.invalidate();
  const cached = await configuration.resolve(pi);
  assert.equal(cached.profile.status, "cached");
  assert.deepEqual(cached.settings.packages, ["npm:context-mode"]);
  assert.ok(cached.warnings.some(warning => /Using cached Pi profile/.test(warning)));
});

test("profile load errors remain visible while inline resources stay usable", async () => {
  const configuration = new PiConfiguration({ fetchImpl: async () => { throw new Error("network unavailable"); } });
  const resolved = await configuration.resolve({
    profile: "https://example.com/settings.json",
    packages: ["npm:fallback"],
    extensions: [],
  });
  assert.equal(resolved.profile.status, "error");
  assert.match(resolved.profile.error, /network unavailable/);
  assert.deepEqual(resolved.settings.packages, ["npm:fallback"]);
});
