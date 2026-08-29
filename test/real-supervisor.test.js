import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RealSupervisor, isPackageSetupFailure } from "../server/supervisor/real.js";

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

test("package command failures are eligible for package-free runtime fallback", () => {
  assert.equal(isPackageSetupFailure(new Error("/usr/local/bin/npm --include=dev install failed with code 1")), true);
  assert.equal(isPackageSetupFailure(new Error("git clone failed with signal SIGTERM")), true);
  assert.equal(isPackageSetupFailure(new Error("Extension path does not exist")), false);
});

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

test("messages reconcile synchronized sessions before a normal prompt", async () => {
  const prompted = [];
  const session = {
    model: { provider: "test", id: "model", api: "test" },
    isStreaming: false,
    prompt: async text => prompted.push(text),
  };
  const supervisor = new RealSupervisor({});
  supervisor.live.set("session-1", {
    session,
    pendingMessages: [],
  });
  supervisor.syncAdapter = {
    beforePrompt: async id => {
      assert.equal(id, "session-1");
      return { switched: false, sessionId: id };
    },
  };
  await supervisor.message("session-1", "hello", "prompt");
  assert.deepEqual(prompted, ["hello"]);
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

test("forked live state accepts client message ids", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-fork-live-"));
  try {
    const script = `
      import fs from "node:fs";
      import { RealSupervisor } from "./server/supervisor/real.js";
      const cwd = process.env.TEST_CWD;
      fs.mkdirSync(cwd, { recursive: true });
      const events = [];
      const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
      const parent = await supervisor.createSession({ cwd });
      supervisor._createConfiguredSession = async ({ sessionManager }) => ({ session: {
        sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager,
        model: { provider: "test", id: "model", api: "test" }, isStreaming: false,
        subscribe() { return () => {}; }, prompt: async () => {}, setSessionName() {},
      }});
      const child = await supervisor.fork(parent.id, null, { cwd });
      const state = supervisor.live.get(child.id);
      await supervisor.message(child.id, "hello", "prompt", [], "client-1");
      supervisor._onEvent(child.id, state, { type: "entry_appended", entry: {
        id: "user-1", type: "message", message: { role: "user", content: "hello" },
      }});
      console.log(JSON.stringify({ pending: state.pendingMessages, event: events.at(-1).data }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "pi"), TEST_CWD: path.join(tmp, "cwd") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.deepEqual(result.pending, []);
    assert.equal(result.event.clientMessageId, "client-1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("web subagent entries become revisioned grouped activity", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = { liveRecords: new Map(), pendingMessages: [], subagents: undefined };
  supervisor._onEvent("session-1", st, {
    type: "entry_appended",
    entry: {
      id: "entry-agent-1", parentId: "assistant-1", type: "custom", customType: "pi-web:subagent",
      data: {
        runId: "agent-1", groupId: "group-1", revision: 1, status: "queued",
        description: "Explore", createdAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  assert.equal(st.subagents.snapshot()[0].status, "queued");
  assert.equal(st.subagents.snapshot()[0].parentMessageId, "assistant-1");
  supervisor._onEvent("session-1", st, {
    type: "entry_appended",
    entry: {
      id: "entry-agent-2", parentId: "assistant-1", type: "custom", customType: "pi-web:subagent",
      data: {
        runId: "agent-1", groupId: "group-1", revision: 2, status: "completed",
        description: "Explore", summary: "Found it.", createdAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
      },
    },
  });
  assert.equal(st.subagents.snapshot()[0].status, "completed");
  assert.equal(st.subagents.snapshot()[0].summary, "Found it.");
  assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.data.record.revision), [1, 2]);
});

test("completed live assistant records do not duplicate persisted messages after transcript refresh", async () => {
  const supervisor = new RealSupervisor({});
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "model_change", id: "m1", parentId: "u1", provider: "test", modelId: "model" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "high" },
    { type: "message", id: "a1", parentId: "t1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  supervisor.live.set("session-1", {
    session: { sessionManager: { getBranch: () => entries } },
    liveRecords: new Map([["a:u1", { id: "a:u1", role: "assistant", text: "answer" }]]),
  });

  const transcript = await supervisor.transcript("session-1");
  assert.deepEqual(transcript.filter(record => record.role === "assistant"), [
    { id: "a:t1", role: "assistant", text: "answer" },
  ]);
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

test("extension command failures propagate through the web supervisor", async () => {
  const failure = Object.assign(new Error("sync failed"), { code: "sync_failure" });
  const supervisor = new RealSupervisor({});
  supervisor._attachById = async () => ({ session: {
    extensionRunner: {
      getCommand: name => name === "sync" ? { handler: async () => { throw failure; } } : undefined,
      createCommandContext: () => ({}),
    },
  } });
  await assert.rejects(supervisor.command("session-1", "/sync refresh"), error => error === failure);
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
    assert.ok(result.pi.runtime.extensions.some(item => item.path === extension));
    assert.ok(result.pi.runtime.extensions.some(item => item.path.endsWith("server/extensions/subagent-telemetry.js")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a failed Pi package install falls back to the core session runtime", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-package-fallback-"));
  try {
    const webHome = path.join(tmp, "web");
    const agentDir = path.join(tmp, "pi");
    const cwd = path.join(tmp, "cwd");
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(webHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
      packages: ["npm:package-that-must-not-install"],
      npmCommand: ["/missing/npm"],
    }));
    fs.writeFileSync(path.join(webHome, "config.json"), JSON.stringify({
      pi: { profile, packages: [], extensions: [] },
    }));
    const fallbackScript = `
      import { EventHub } from './server/events.js';
      import { RealSupervisor } from './server/supervisor/real.js';
      const supervisor = new RealSupervisor(new EventHub());
      const created = await supervisor.createSession({ cwd: process.env.TEST_CWD });
      const commands = await supervisor.commands(created.id);
      console.log(JSON.stringify({ commands: commands.map(command => command.name), pi: await supervisor.piConfigurationState() }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", fallbackScript], {
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
    assert.ok(result.commands.includes("settings"));
    assert.deepEqual(result.pi.runtime.packageStatus, { configured: 1, loaded: 0, failed: 1 });
    assert.match(result.pi.runtime.errors.find(error => error.path === "<pi-packages>")?.error || "", /ENOENT/);
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
