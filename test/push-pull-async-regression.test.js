import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, child, output, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited before Git shim blocked\n${output()}`);
    await delay(10);
  }
  assert.ok(fs.existsSync(file), `timed out waiting for Git shim\n${output()}`);
}

async function fetchJson(url, options = {}, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(1_500).then(() => false)])) return true;
  child.kill("SIGKILL");
  return Promise.race([exited.then(() => true), delay(1_500).then(() => false)]);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitTrace(file) {
  const contents = fs.readFileSync(file, "utf8").trim();
  return contents ? contents.split(/\r?\n/).map(line => {
    const separator = line.indexOf("\t");
    return { cwd: line.slice(0, separator), args: line.slice(separator + 1) };
  }) : [];
}

test("push and pull keep Git async, repository admission held, and release on every exit", { timeout: 120_000 }, async () => {
  const fixture = createWorkspaceFixture();
  const tmp = fixture.tmp;
  const home = path.join(tmp, "home");
  const remote = path.join(tmp, "remote.git");
  const bin = path.join(tmp, "bin");
  const control = path.join(tmp, "git-control");
  const controlDir = path.join(tmp, "git-holds");
  const traceFile = path.join(tmp, "git-trace");
  const projectId = "p-push-pull-async";
  const phases = ["discovery", "preview", "push-success", "push-failure", "pull-success", "pull-failure"];
  const gitDir = fs.realpathSync(fixture.repo);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  let child;
  let port;
  let sessionId;
  let stdout = "";
  let stderr = "";
  let childError = null;
  let lineBuffer = "";
  const pendingRequests = [];
  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}\nchild error: ${childError?.stack || "none"}`;
  const marker = phase => path.join(controlDir, `${phase}.marker`);
  const release = phase => path.join(controlDir, `${phase}.release`);
  const finished = phase => path.join(controlDir, `${phase}.finished`);
  const trace = () => gitTrace(traceFile);
  const snapshot = () => ({
    localRefs: git(fixture.repo, "show-ref").trim(),
    remoteRefs: execFileSync(realGit, ["--git-dir", remote, "show-ref"], { cwd: tmp, encoding: "utf8" }).trim(),
    status: git(fixture.repo, "status", "--porcelain").trim(),
  });

  try {
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(controlDir);
    fs.writeFileSync(control, "");
    fs.writeFileSync(traceFile, "");
    assert.deepEqual(await ws.pushPreviewAsync(fixture.repo), ws.pushPreview(fixture.repo));
    git(tmp, "init", "--bare", "--initial-branch=main", remote);
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "push", "-u", "origin", "main");
    fs.writeFileSync(path.join(fixture.repo, "push-success.txt"), "push\n");
    git(fixture.repo, "add", "push-success.txt");
    git(fixture.repo, "commit", "-m", "push success");
    fs.writeFileSync(path.join(fixture.repo, "untracked.txt"), "dirty preview\n");
    assert.equal(await ws.currentHeadAsync(fixture.repo), ws.currentHead(fixture.repo));
    assert.equal(await ws.branchUpstreamAsync(fixture.repo), ws.branchUpstream(fixture.repo));
    assert.equal(await ws.remoteBranchForLocalAsync(fixture.repo, "main"), ws.remoteBranchForLocal(fixture.repo, "main"));
    assert.equal(await ws.isDirtyAsync(fixture.repo), ws.isDirty(fixture.repo));
    assert.deepEqual(await ws.pushPreviewAsync(fixture.repo, { limit: 1 }), ws.pushPreview(fixture.repo, { limit: 1 }));
    await assert.rejects(ws.isDirtyAsync(path.join(tmp, "missing-repository")), error => error.code === "git_status_unavailable");
    const spawnEvents = [];
    await assert.rejects(ws.pullWorkspaceAsync(path.join(tmp, "missing-repository"), { report: event => spawnEvents.push(event) }), error => error.code === "git_pull_failed");
    assert.equal(spawnEvents.filter(event => event.type === "process_end").length, 1);

    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      reposRoot: tmp,
      worktreeRoot: path.join(home, "worktrees"),
      projects: [{ id: projectId, name: "repo", repoPath: fixture.repo, source: { type: "local" }, hooks: {} }],
    }));
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
set -eu
printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$PI_TEST_GIT_TRACE"
phase=$(cat "$PI_TEST_GIT_CONTROL")
expected=
case "$phase" in
  discovery) expected='worktree list --porcelain' ;;
  preview) expected='status --porcelain' ;;
  push-success|push-failure) expected='push' ;;
  pull-success|pull-failure) expected='pull --ff-only' ;;
esac
if [ -n "$expected" ] && [ "$(pwd -P)" = "$PI_TEST_GIT_REPO" ] && [ "$*" = "$expected" ]; then
  : > "$PI_TEST_GIT_HOLDS/$phase.marker"
  i=0
  while [ ! -e "$PI_TEST_GIT_HOLDS/$phase.release" ] && [ "$i" -lt 300 ]; do
    /bin/sleep 0.05
    i=$((i + 1))
  done
  if [ ! -e "$PI_TEST_GIT_HOLDS/$phase.release" ]; then
    printf '%s\\n' 'Git shim release deadline expired' >&2
    : > "$PI_TEST_GIT_HOLDS/$phase.finished"
    exit 98
  fi
  : > "$PI_TEST_GIT_HOLDS/$phase.finished"
  case "$phase" in
    push-failure) printf '%s\\n' 'intentional push failure' >&2; exit 42 ;;
    pull-failure) printf '%s\\n' 'intentional pull failure' >&2; exit 42 ;;
  esac
fi
exec "$PI_TEST_GIT_REAL" "$@"
`);
    fs.chmodSync(path.join(bin, "git"), 0o700);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { startServer } from ${JSON.stringify(new URL("../server/index.js", import.meta.url).href)};
      import { saveBindings } from ${JSON.stringify(new URL("../server/config.js", import.meta.url).href)};
      const { server, sup } = startServer(0);
      await new Promise(resolve => server.listening ? resolve() : server.once("listening", resolve));
      const session = await sup.createSession({ cwd: process.env.PI_TEST_GIT_REPO });
      saveBindings({ [session.id]: { projectId: ${JSON.stringify(projectId)}, workspacePath: process.env.PI_TEST_GIT_REPO } });
      console.log(JSON.stringify({ port: server.address().port, sessionId: session.id }));
    `], {
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`,
        HOME: home,
        PI_WEB_HOME: home,
        PI_WEB_MODE: "mock",
        PI_WEB_UI_ONLY: "0",
        PI_WEB_PRESTART_COMMAND: "",
        PI_WEB_MOCK_THINK_MS: "0",
        PI_WEB_MOCK_DELTA_MS: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PI_TEST_GIT_REAL: realGit,
        PI_TEST_GIT_REPO: gitDir,
        PI_TEST_GIT_CONTROL: control,
        PI_TEST_GIT_HOLDS: controlDir,
        PI_TEST_GIT_TRACE: traceFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", error => { childError = error; });
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const ready = JSON.parse(line);
          port = ready.port;
          sessionId = ready.sessionId;
        } catch {}
      }
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const startupDeadline = Date.now() + 10_000;
    while (!port && !childError && Date.now() < startupDeadline && child.exitCode === null && child.signalCode === null) await delay(10);
    assert.ok(port && sessionId, `server failed to start\n${output()}`);
    fs.writeFileSync(traceFile, "");
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body = {}) => fetchJson(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);
    const checkResponsive = async phase => {
      const health = await fetchJson(`${base}/api/health`);
      assert.equal(health.status, 200, `health did not complete while ${phase} Git was held\n${output()}`);
      assert.equal(fs.existsSync(release(phase)), false, `${phase} Git was released before health completed\n${output()}`);
      assert.equal(fs.existsSync(finished(phase)), false, `${phase} Git finished before health completed\n${output()}`);
    };
    const checkBusyNoEffects = async phase => {
      const before = snapshot();
      const previousFetches = trace().filter(item => item.args === "fetch --all --prune").length;
      const result = await post(`/api/projects/${projectId}/fetch`);
      assert.equal(result.status, 409, `same-repository mutation was not rejected during ${phase}\n${JSON.stringify(result.body)}\n${output()}`);
      assert.equal(result.body.error, "repository_busy");
      assert.deepEqual(snapshot(), before);
      assert.equal(trace().filter(item => item.args === "fetch --all --prune").length, previousFetches);
    };
    const beginHold = phase => {
      for (const file of [marker(phase), release(phase), finished(phase)]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, phase);
    };
    const releaseHold = (phase, nextPhase = "") => {
      fs.writeFileSync(control, nextPhase);
      fs.writeFileSync(release(phase), "release\n");
    };
    const checkCommand = (phase, args) => assert.ok(trace().some(item => item.cwd === gitDir && item.args === args), `${phase} async Git command was not observed\n${output()}`);
    const runHeld = async ({ endpoint, phase, preview = false, body = {} }) => {
      for (const heldPhase of preview ? [phase, "preview"] : [phase]) {
        for (const file of [marker(heldPhase), release(heldPhase), finished(heldPhase)]) fs.rmSync(file, { force: true });
      }
      beginHold("discovery");
      const request = post(`/api/sessions/${sessionId}/${endpoint}`, body).then(value => ({ value }), error => ({ error }));
      pendingRequests.push(request);
      await waitForFile(marker("discovery"), child, output);
      checkCommand("discovery", "worktree list --porcelain");
      await checkResponsive("discovery");
      const operationPhase = preview ? "preview" : phase;
      releaseHold("discovery", operationPhase);
      if (preview) {
        await waitForFile(marker("preview"), child, output);
        checkCommand("preview", "status --porcelain");
        await checkResponsive("preview");
        await checkBusyNoEffects("preview");
        releaseHold("preview", phase);
      }
      await waitForFile(marker(phase), child, output);
      checkCommand(phase, phase.startsWith("push") ? "push" : "pull --ff-only");
      await checkResponsive(phase);
      await checkBusyNoEffects(phase);
      releaseHold(phase);
      const outcome = await request;
      assert.equal(outcome.error, undefined, outcome.error?.stack || output());
      assert.ok(fs.existsSync(finished(phase)), `${phase} Git subprocess did not finish\n${output()}`);
      return outcome.value;
    };
    const verifyAdmissionReleased = async phase => {
      const result = await post(`/api/projects/${projectId}/fetch`);
      assert.equal(result.status, 200, `repository admission remained held after ${phase}\n${JSON.stringify(result.body)}\n${output()}`);
    };

    const pushSuccess = await runHeld({ endpoint: "push", phase: "push-success", preview: true });
    assert.equal(pushSuccess.status, 200, JSON.stringify(pushSuccess.body));
    assert.equal(pushSuccess.body.branch, "main");
    assert.equal(pushSuccess.body.command, "git push");
    assert.equal(pushSuccess.body.operation.status, "success");
    assert.ok(pushSuccess.body.operation.events.some(event => event.type === "process_start" && event.command === "git push"));
    assert.ok(pushSuccess.body.operation.events.some(event => event.type === "process_end" && event.command === "git push" && event.exit === 0));
    assert.equal(git(remote, "rev-parse", "refs/heads/main").trim(), git(fixture.repo, "rev-parse", "HEAD").trim());
    await verifyAdmissionReleased("successful push");

    const pushFailure = await runHeld({ endpoint: "push", phase: "push-failure", preview: true });
    assert.equal(pushFailure.status, 409);
    assert.equal(pushFailure.body.error, "git_push_failed");
    assert.ok(pushFailure.body.detail.length <= 1200);
    assert.equal(pushFailure.body.operation.status, "error");
    await verifyAdmissionReleased("failed push");

    const peer = path.join(tmp, "peer");
    git(tmp, "clone", remote, peer);
    git(peer, "config", "user.email", "t@t");
    git(peer, "config", "user.name", "t");
    fs.writeFileSync(path.join(peer, "pull-success.txt"), "pull\n");
    git(peer, "add", "pull-success.txt");
    git(peer, "commit", "-m", "pull success");
    git(peer, "push", "origin", "main");
    const pullSuccess = await runHeld({ endpoint: "pull", phase: "pull-success" });
    assert.equal(pullSuccess.status, 200, JSON.stringify(pullSuccess.body));
    assert.equal(pullSuccess.body.branch, "main");
    assert.equal(git(fixture.repo, "rev-parse", "HEAD").trim(), git(remote, "rev-parse", "refs/heads/main").trim());
    await verifyAdmissionReleased("successful pull");

    fs.writeFileSync(path.join(peer, "pull-failure.txt"), "pull failure\n");
    git(peer, "add", "pull-failure.txt");
    git(peer, "commit", "-m", "pull failure");
    git(peer, "push", "origin", "main");
    const pullFailure = await runHeld({ endpoint: "pull", phase: "pull-failure" });
    assert.equal(pullFailure.status, 409);
    assert.equal(pullFailure.body.error, "git_pull_failed");
    assert.ok(pullFailure.body.detail.length <= 1000);
    assert.match(pullFailure.body.detail, /intentional pull failure/);
    await verifyAdmissionReleased("failed pull");
  } finally {
    for (const phase of phases) fs.writeFileSync(release(phase), "release\n");
    fs.writeFileSync(control, "");
    if (child) {
      const stopped = await stopChild(child);
      assert.ok(stopped, `child server failed to terminate\n${output()}`);
    }
    await Promise.allSettled(pendingRequests);
    fixture.close();
  }
});
