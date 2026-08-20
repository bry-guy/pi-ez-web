import assert from "node:assert/strict";
import test from "node:test";
import { WEB_PI_COMMANDS, commandInfo, parseSlashCommand } from "../server/commands.js";

const expectedBuiltins = [
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
  "changelog", "hotkeys", "tree", "trust", "login", "logout", "new", "compact",
  "resume", "reload", "quit", "debug",
];

test("web command discovery includes Pi built-ins", () => {
  const names = commandInfo().map(command => command.name);
  for (const name of expectedBuiltins) assert.ok(names.includes(name), `missing /${name}`);
  assert.equal(names.length, WEB_PI_COMMANDS.length);
});

test("command discovery preserves extension, prompt, and skill arguments", () => {
  const commands = commandInfo({
    commands: [{ name: "format", invocationName: "format:2", description: "Format files", argumentHint: "<path>" }],
    prompts: [{ name: "review", description: "Review code", argumentHint: "[focus]" }],
    skills: [{ name: "advisor", description: "Ask advisor", disableModelInvocation: false }],
  });
  assert.deepEqual(commands.at(-3), { name: "format:2", description: "Format files", argumentHint: "<path>", source: "extension" });
  assert.deepEqual(commands.at(-2), { name: "review", description: "Review code", argumentHint: "[focus]", source: "prompt" });
  assert.deepEqual(commands.at(-1), { name: "skill:advisor", description: "Ask advisor", argumentHint: "[arguments]", source: "skill" });
});

test("slash parsing preserves multiline arguments", () => {
  assert.deepEqual(parseSlashCommand(" /compact keep the API section\nunder 2k tokens "), {
    name: "compact", args: "keep the API section\nunder 2k tokens", text: "/compact keep the API section\nunder 2k tokens",
  });
  assert.equal(parseSlashCommand("not a command"), null);
});
