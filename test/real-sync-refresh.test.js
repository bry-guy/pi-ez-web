import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function scenario() {
  const assert = (await import("node:assert/strict")).default;
  const fs = (await import("node:fs")).default;
  const http = (await import("node:http")).default;
  const path = (await import("node:path")).default;
  const { pathToFileURL } = await import("node:url");
  const root = process.env.TEST_ROOT;
  const repo = process.env.TEST_REPO;
  const webHome = path.join(root, "web");
  const agentDir = path.join(root, "pi");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(webHome, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  let remote;
  let etag = "e1";
  let lease;
  let leaseNumber = 0;
  const send = (response, status, value) => {
    response.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  const readBody = async request => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return text ? JSON.parse(text) : {};
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/v1/health" && request.method === "GET") {
        return send(response, 200, { status: "ok", formatVersion: 1, heartbeatSeconds: 20, leaseExpirySeconds: 120 });
      }
      if (url.pathname === "/v1/sessions" && request.method === "GET") {
        return send(response, 200, {
          formatVersion: 1,
          sessions: remote ? [{
            sessionId: remote.sessionId,
            title: remote.title,
            createdAt: remote.createdAt,
            headEntryId: remote.headEntryId,
            etag,
            leaseHolder: lease?.holder || null,
            leaseExpiresAt: lease?.expiresAt || null,
          }] : [],
        });
      }
      const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/lease$/);
      if (match && decodeURIComponent(match[1]) === remote?.sessionId && request.method === "POST") {
        if (lease) return send(response, 423, { error: { code: "active_lease", message: "lease is active" } });
        const body = await readBody(request);
        const acquiredAt = new Date().toISOString();
        lease = {
          token: `lease-${++leaseNumber}`,
          holder: body.holder || "test-client",
          acquiredAt,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        };
        return send(response, 200, { formatVersion: 1, session: remote, etag, lease });
      }
      if (match && decodeURIComponent(match[1]) === remote?.sessionId && request.method === "DELETE") {
        if (!lease || request.headers["x-pi-sync-lease"] !== lease.token) {
          return send(response, 423, { error: { code: "lease_invalid", message: "lease is invalid" } });
        }
        lease = undefined;
        return send(response, 204);
      }
      return send(response, 404, { error: { code: "not_found", message: "not found" } });
    } catch (error) {
      return send(response, 500, { error: { code: "fake_server_error", message: String(error) } });
    }
  });

  let supervisor;
  let adapter;
  let restartedSupervisor;
  let restartedAdapter;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(webHome, "config.json"), JSON.stringify({
    sync: { serverUrl, allConversations: false },
    pi: { profile: null, profileSource: "disabled", packages: [], extensions: [] },
  }));

  try {
    const [{ hub }, { RealSupervisor }, { PiSyncWebAdapter }, { buildApi }] = await Promise.all([
      import(pathToFileURL(path.join(repo, "server/events.js"))),
      import(pathToFileURL(path.join(repo, "server/supervisor/real.js"))),
      import(pathToFileURL(path.join(repo, "server/sync/web-adapter.js"))),
      import(pathToFileURL(path.join(repo, "server/routes.js"))),
    ]);
    const syncModule = await import(pathToFileURL(path.join(repo, "vendor/pi-sync/dist/src/index.js")));
    supervisor = new RealSupervisor(hub);
    adapter = new PiSyncWebAdapter({ hub, supervisor });
    const api = buildApi(supervisor, { syncAdapter: adapter });
    const created = await supervisor.createSession({ cwd });
    const id = created.id;
    const initialFile = supervisor.paths.get(id);
    const blank = await syncModule.normalizeSessionFile(initialFile);
    const initial = {
      ...blank,
      title: "sync refresh integration",
      headEntryId: "seed-message",
      entries: [
        {
          type: "session_info",
          id: "seed-name",
          parentId: null,
          timestamp: new Date(Date.now() + 1).toISOString(),
          name: "sync refresh integration",
        },
        {
          type: "message",
          id: "seed-message",
          parentId: "seed-name",
          timestamp: new Date(Date.now() + 2).toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "initial local history" }],
            timestamp: Date.now(),
          },
        },
      ],
    };
    await syncModule.materializeSessionFile(initialFile, initial, { cwd });
    await supervisor.commands(id);
    remote = await syncModule.normalizeSessionFile(initialFile);
    const bindings = await adapter.bindingStore();
    await bindings.set({
      nativeSessionId: id,
      serverUrl,
      canonicalSessionId: id,
      lastEtag: etag,
      materializedFile: initialFile,
      lastFingerprint: syncModule.stableEnvelopeFingerprint(remote),
      state: "ready",
    });

    const request = async (target, pathname, body) => {
      const response = await target.request(`http://pi-web.test${pathname}`, body === undefined ? undefined : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const transcript = async target => {
      const result = await request(target, `/sessions/${id}/transcript`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.snapshotToken);
      assert.ok(Array.isArray(result.body.records));
      return result.body;
    };
    const persistedBinding = async () => {
      await bindings.load();
      return bindings.get(id);
    };
    const check = async () => {
      const result = await request(api, `/sessions/${id}/sync/check`, {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    let entryNumber = 0;
    const appendMessage = (envelope, id, text) => {
      const timestamp = new Date(Date.now() + ++entryNumber).toISOString();
      return {
        ...envelope,
        headEntryId: id,
        entries: [...envelope.entries, {
          type: "message",
          id,
          parentId: envelope.headEntryId || null,
          timestamp,
          message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() + entryNumber },
        }],
      };
    };

    const tabOne = await transcript(api);
    const tabTwo = await transcript(api);
    assert.equal(tabOne.snapshotToken, tabTwo.snapshotToken);

    const liveSession = supervisor.live.get(id).session;
    const originalModel = Object.getOwnPropertyDescriptor(liveSession, "model");
    const originalPrompt = Object.getOwnPropertyDescriptor(liveSession, "prompt");
    Object.defineProperty(liveSession, "model", { configurable: true, value: { provider: "test", id: "model", api: "test" } });
    let finishPrompt;
    let signalPromptStarted;
    const promptStarted = new Promise(resolve => { signalPromptStarted = resolve; });
    liveSession.prompt = () => { signalPromptStarted(); return new Promise(resolve => { finishPrompt = resolve; }); };
    try {
      const pending = await request(api, `/sessions/${id}/message`, { text: "pending admission", snapshotToken: tabOne.snapshotToken });
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
      await promptStarted;
      remote = appendMessage(remote, "remote-one", "remote history one");
      etag = "e2";
      assert.equal((await check()).outcome, "busy");
    } finally {
      finishPrompt?.();
      if (originalModel) Object.defineProperty(liveSession, "model", originalModel); else delete liveSession.model;
      if (originalPrompt) Object.defineProperty(liveSession, "prompt", originalPrompt); else delete liveSession.prompt;
    }
    await new Promise(resolve => setImmediate(resolve));
    const first = await check();
    assert.equal(first.outcome, "refreshed");
    assert.equal(first.sessionId, id);
    const firstBinding = await persistedBinding();
    assert.notEqual(firstBinding.materializedFile, initialFile);
    const firstTranscript = await transcript(api);
    assert.notEqual(firstTranscript.snapshotToken, tabOne.snapshotToken);
    assert.ok(firstTranscript.records.some(record => record.text === "remote history one"));

    const staleMessage = await request(api, `/sessions/${id}/message`, {
      text: "must not be sent",
      snapshotToken: tabOne.snapshotToken,
    });
    assert.equal(staleMessage.status, 409);
    assert.equal(staleMessage.body.error, "sync_snapshot_stale");

    const marker = path.join(root, "stale-bang-ran");
    const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const staleBang = await request(api, `/sessions/${id}/bang`, {
      cmd: `touch ${shellQuote(marker)}`,
      snapshotToken: tabTwo.snapshotToken,
    });
    assert.equal(staleBang.status, 409);
    assert.equal(staleBang.body.error, "sync_snapshot_stale");
    assert.equal(fs.existsSync(marker), false);

    const commands = await request(api, `/sessions/${id}/commands`);
    assert.equal(commands.status, 200);
    assert.ok(commands.body.commands.some(command => command.name === "skill:synchronized-workspace" && command.source === "skill"));
    const stalePrompt = await request(api, `/sessions/${id}/command`, {
      text: "/skill:synchronized-workspace",
      snapshotToken: tabOne.snapshotToken,
    });
    assert.equal(stalePrompt.status, 409);
    assert.equal(stalePrompt.body.error, "sync_snapshot_stale");

    remote = appendMessage(remote, "remote-two", "remote history two");
    etag = "e3";
    const second = await check();
    assert.equal(second.outcome, "refreshed");
    assert.equal(second.sessionId, id);
    const secondBinding = await persistedBinding();
    assert.notEqual(secondBinding.materializedFile, firstBinding.materializedFile);
    const secondTranscript = await transcript(api);
    assert.notEqual(secondTranscript.snapshotToken, firstTranscript.snapshotToken);
    assert.ok(secondTranscript.records.some(record => record.text === "remote history one"));
    assert.ok(secondTranscript.records.some(record => record.text === "remote history two"));

    const unchanged = await check();
    assert.equal(unchanged.outcome, "unchanged");
    assert.equal((await persistedBinding()).materializedFile, secondBinding.materializedFile);
    assert.equal((await transcript(api)).snapshotToken, secondTranscript.snapshotToken);

    const bangOnly = await request(api, `/sessions/${id}/bang`, {
      cmd: "printf 'bang-only divergence'", snapshotToken: secondTranscript.snapshotToken,
    });
    assert.equal(bangOnly.status, 200);
    const bangOnlyBytes = fs.readFileSync(secondBinding.materializedFile, "utf8");
    assert.ok(bangOnlyBytes.includes("pi-web:bang"));
    remote = appendMessage(remote, "remote-three", "remote history three");
    etag = "e4";
    assert.equal((await check()).outcome, "conflict", "a bang alone prevents automatic replacement");
    assert.equal((await persistedBinding()).materializedFile, secondBinding.materializedFile);
    assert.equal(fs.readFileSync(secondBinding.materializedFile, "utf8"), bangOnlyBytes);

    const manual = await request(api, `/sessions/${id}/sync/refresh`, {});
    assert.equal(manual.status, 200, JSON.stringify(manual.body));
    const baselineBinding = await persistedBinding();
    const baselineTranscript = await transcript(api);
    assert.notEqual(baselineTranscript.snapshotToken, secondTranscript.snapshotToken);
    const localEntry = appendMessage(remote, "local-only", "local unsynchronized history").entries.at(-1);
    fs.appendFileSync(baselineBinding.materializedFile, `${JSON.stringify(localEntry)}\n`);
    const localBytes = fs.readFileSync(baselineBinding.materializedFile, "utf8");
    const fingerprint = baselineBinding.lastFingerprint;
    remote = appendMessage(remote, "remote-four", "remote history four");
    etag = "e5";
    const conflict = await check();
    assert.equal(conflict.outcome, "conflict");
    assert.equal(fs.readFileSync(baselineBinding.materializedFile, "utf8"), localBytes);
    const afterConflict = await persistedBinding();
    assert.equal(afterConflict.materializedFile, baselineBinding.materializedFile);
    assert.equal(afterConflict.lastEtag, "e4");
    assert.equal(afterConflict.lastFingerprint, fingerprint);

    const decoy = appendMessage(remote, "decoy-entry", "unbound decoy history");
    const decoyFile = path.join(path.dirname(afterConflict.materializedFile), `9999999999999_${id}.jsonl`);
    await syncModule.materializeSessionFile(decoyFile, decoy, { cwd });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(decoyFile, future, future);
    restartedSupervisor = new RealSupervisor(hub);
    restartedAdapter = new PiSyncWebAdapter({ hub, supervisor: restartedSupervisor });
    const restartedApi = buildApi(restartedSupervisor, { syncAdapter: restartedAdapter });
    assert.equal(await restartedSupervisor.sessionFile(id), afterConflict.materializedFile);
    const restarted = await transcript(restartedApi);
    assert.equal(restarted.snapshotToken, baselineTranscript.snapshotToken);
    assert.ok(restarted.records.some(record => record.text === "local unsynchronized history"));
    assert.equal(restarted.records.some(record => record.text === "unbound decoy history"), false);

    const originalBangRecord = restartedSupervisor.bangRecord.bind(restartedSupervisor);
    let signalBangPersistence;
    const bangPersistenceStarted = new Promise(resolve => { signalBangPersistence = resolve; });
    let finishBangPersistence;
    restartedSupervisor.bangRecord = async (...args) => {
      signalBangPersistence();
      await new Promise(resolve => { finishBangPersistence = resolve; });
      return originalBangRecord(...args);
    };
    const bangRequest = request(restartedApi, `/sessions/${id}/bang`, {
      cmd: "printf 'persisted bang'",
      snapshotToken: restarted.snapshotToken,
    });
    await bangPersistenceStarted;
    assert.equal((await request(restartedApi, `/sessions/${id}/sync/check`, {})).body.outcome, "busy");
    finishBangPersistence();
    assert.equal((await bangRequest).status, 200);
    const bangEntries = fs.readFileSync(afterConflict.materializedFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(bangEntries.some(entry => entry.customType === "pi-web:bang" && entry.data?.cmd === "printf 'persisted bang'"));
    assert.equal((await request(restartedApi, `/sessions/${id}/sync/check`, {})).body.outcome, "conflict");
  } finally {
    for (const current of [supervisor, restartedSupervisor]) {
      if (!current) continue;
      for (const state of current.live.values()) await current._disposeLiveState(state, "quit");
      current.live.clear();
    }
    await adapter?.close();
    await restartedAdapter?.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

test("real JSON-mode sync auto-check refreshes and preserves bound snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-sync-refresh-"));
  try {
    const childScript = `(${scenario.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`;
    execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: repo,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: path.join(root, "home"),
        TEST_ROOT: root,
        TEST_REPO: repo,
        PI_WEB_HOME: path.join(root, "web"),
        PI_CODING_AGENT_DIR: path.join(root, "pi"),
        PI_WEB_SYNC_CLIENT_MODULE: path.join(repo, "vendor/pi-sync"),
        PI_WEB_REPOS_ROOT: path.join(root, "repos"),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
