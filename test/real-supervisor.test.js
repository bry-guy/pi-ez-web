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

test("compaction events become visible status activities", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = { liveRecords: new Map(), pendingMessages: [] };
  supervisor._onEvent("session-1", st, { type: "compaction_start", reason: "manual" });
  assert.deepEqual(st.liveRecords.get("activity:compaction"), {
    id: "activity:compaction", role: "activity", kind: "status", key: "compaction", status: "running",
    title: "Compacting", summary: "context…", items: [], source: "pi",
  });
  supervisor._onEvent("session-1", st, { type: "compaction_end", reason: "manual", result: {}, aborted: false });
  assert.equal(st.liveRecords.get("activity:compaction").status, "completed");
  assert.deepEqual(events.map(event => [event.type, event.data.record.status]), [
    ["activity", "running"], ["activity", "completed"],
  ]);
  st.pendingMessages.push({ clientMessageId: "client-1", text: "hello" });
  supervisor._onEvent("session-1", st, { type: "entry_appended", entry: {
    id: "user-1", type: "message", message: { role: "user", content: "hello" },
  } });
  assert.equal(events.at(-1).data.clientMessageId, "client-1");
});

test("provider error events end the turn with a public error", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = {
    liveRecords: new Map([["assistant-1", { id: "assistant-1", role: "assistant", text: "", streaming: true }]]),
    pendingMessages: [], msgId: "assistant-1", turnId: "turn-1", turnEnded: false,
  };
  supervisor._onEvent("session-1", st, {
    type: "message_update",
    assistantMessageEvent: {
      type: "error",
      error: { role: "assistant", stopReason: "error", errorMessage: "Insufficient quota." },
    },
  });
  assert.equal(st.turnEnded, true);
  assert.equal(st.liveRecords.get("assistant-1").streaming, undefined);
  assert.deepEqual(events.map(event => [event.type, event.data.reason, event.data.error]), [
    ["message_end", undefined, undefined], ["turn_end", "errored", "Insufficient quota."],
  ]);
  supervisor._onEvent("session-1", st, { type: "agent_end", messages: [] });
  assert.equal(events.length, 2);
});

test("manual compact reports expected no-op states instead of an internal error", async () => {
  const supervisor = new RealSupervisor({});
  for (const [message, expected] of [
    ["Already compacted", "Session is already compacted."],
    ["Nothing to compact (session too small)", "Nothing to compact yet; the session is too small."],
  ]) {
    supervisor._attachById = async () => ({ session: { compact: async () => { throw new Error(message); } } });
    assert.deepEqual(await supervisor.command("session-1", "/compact"), {
      action: "notice", title: "Compact", message: expected,
    });
  }
});

test("configured extensions load commands and session_start tools", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-extension-"));
  try {
    const webHome = path.join(tmp, "web");
    const agentDir = path.join(tmp, "pi");
    const cwd = path.join(tmp, "cwd");
    const extension = path.join(tmp, "configured-extension.ts");
    fs.mkdirSync(webHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(extension, `
      export default function (pi) {
        pi.registerCommand("configured-command", { description: "configured", async handler() {} });
        pi.on("session_start", () => pi.registerTool({
          name: "startup_tool", label: "Startup", description: "registered at session_start",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
        }));
      }
    `);
    fs.writeFileSync(path.join(webHome, "config.json"), JSON.stringify({
      pi: { profile: null, packages: [], extensions: [extension] },
    }));
    const extensionScript = `
      import { EventHub } from './server/events.js';
      import { RealSupervisor } from './server/supervisor/real.js';
      const supervisor = new RealSupervisor(new EventHub());
      const created = await supervisor.createSession({ cwd: process.env.TEST_CWD });
      const commands = await supervisor.commands(created.id);
      const tools = supervisor.live.get(created.id).session.getAllTools().map(tool => tool.name);
      console.log(JSON.stringify({ commands: commands.map(command => command.name), tools, pi: await supervisor.piConfigurationState() }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", extensionScript], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: webHome,
        PI_CODING_AGENT_DIR: agentDir,
        TEST_CWD: cwd,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.ok(result.commands.includes("configured-command"));
    assert.ok(result.tools.includes("startup_tool"));
    assert.equal(result.pi.runtime.extensions.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
