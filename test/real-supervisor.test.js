import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RealSupervisor } from "../server/supervisor/real.js";

const script = `
  import { startServer } from './server/index.js';
  const { server } = startServer(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const providersResponse = await fetch(base + '/api/providers');
  const providers = await providersResponse.json();
  const created = await (await fetch(base + '/api/chats', { method: 'POST' })).json();
  const commandsResponse = await fetch(base + '/api/sessions/' + created.id + '/commands');
  const commands = await commandsResponse.json();
  const message = await fetch(base + '/api/sessions/' + created.id + '/message', {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({text:'hello'})
  });
  const transcript = await (await fetch(base + '/api/sessions/' + created.id + '/transcript')).json();
  console.log(JSON.stringify({providersStatus: providersResponse.status, providers, created, commandsStatus: commandsResponse.status, commands, messageStatus: message.status, message: await message.json(), transcript}));
  server.closeAllConnections?.(); server.close();
`;

test("model-less session attachment resolves the configured default before creating Pi's session", async () => {
  const supervisor = new RealSupervisor({});
  supervisor.paths.set("session-1", "/tmp/session-1.jsonl");
  supervisor._discover = async () => true;
  supervisor._boundCwd = () => "/tmp";
  supervisor._preferredModel = async () => "openai-codex/gpt-5.6-luna";
  let attached;
  supervisor._attach = async (...args) => { attached = args; return { session: {} }; };

  await supervisor._attachById("session-1");
  assert.deepEqual(attached, ["session-1", "/tmp", "openai-codex/gpt-5.6-luna"]);
});

test("real sessions can be created without provider credentials", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: path.join(tmp, "web"),
        PI_CODING_AGENT_DIR: path.join(tmp, "pi"),
        PI_WEB_MODE: "real",
        PI_WEB_REPOS_ROOT: path.join(tmp, "repos"),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(result.providersStatus, 200);
    assert.ok(result.providers.providers.some(provider => provider.id === "anthropic"));
    assert.ok(result.created.id);
    assert.equal(result.commandsStatus, 200);
    assert.ok(result.commands.commands.some(command => command.name === "settings"));
    assert.ok(result.commands.commands.some(command => command.name === "name"));
    assert.equal(result.messageStatus, 409);
    assert.equal(result.message.error, "model_required");
    assert.deepEqual(result.transcript.records, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
