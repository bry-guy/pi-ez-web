import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test("worktree creation and stash transfer are responsive and preserve index, files and existing stashes", { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-transfer-"));
  const bin = path.join(tmp, "bin"), control = path.join(tmp, "control"), marker = path.join(tmp, "marker"), release = path.join(tmp, "release"), parentFile = path.join(tmp, "parent");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  let child, output = "";
  const pending = [];
  try {
    fs.mkdirSync(bin); fs.writeFileSync(control, ""); fs.writeFileSync(parentFile, "");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
set -eu
mode=; parent=
IFS= read -r mode < "$PI_TEST_CONTROL" || :
IFS= read -r parent < "$PI_TEST_PARENT" || :
held=false
case "$mode:$*" in
  create-read:'check-ref-format --branch create-'*|create:'worktree add '*|read:'status --porcelain'|stash:'stash push '*|cleanup:'worktree remove '*) held=true ;;
  apply-fail:'stash apply --index '*) if [ "$(pwd -P)" != "$parent" ]; then held=true; fi ;;
  restore-fail:'stash apply --index '*) if [ "$(pwd -P)" = "$parent" ]; then held=true; fi ;;
esac
if [ "$held" = true ]; then
  : > "$PI_TEST_MARKER"
  i=0
  while [ ! -e "$PI_TEST_RELEASE" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.05; i=$((i + 1)); done
  [ -e "$PI_TEST_RELEASE" ] || exit 98
  case "$mode" in *-fail) echo 'intentional stash failure' >&2; exit 42 ;; esac
fi
exec "$PI_TEST_REAL_GIT" "$@"
`);
    fs.chmodSync(path.join(bin, "git"), 0o700);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createIsolatedServerFixture } from ${JSON.stringify(new URL("./helpers/isolated-server-fixture.js", import.meta.url).href)};
      const fixture = await createIsolatedServerFixture();
      const { loadBindings } = await import(${JSON.stringify(new URL("../server/config.js", import.meta.url).href)});
      const originalStreaming = fixture.supervisor.isStreaming.bind(fixture.supervisor), originalFork = fixture.supervisor.fork.bind(fixture.supervisor);
      let flags = {};
      fixture.supervisor.isStreaming = id => flags.streaming === id || originalStreaming(id);
      fixture.supervisor.fork = async (...args) => { if (flags.badFork) throw Object.assign(new Error('bad_fork_record'), { code: 'bad_fork_record' }); return originalFork(...args); };
      const seed = id => { const session = fixture.supervisor._load(id); session.records = [{ id: 'u1', role: 'user', text: 'create workspace' }]; fixture.supervisor._save(session); };
      seed(fixture.mainSessionId);
      process.on('message', async message => {
        if (message.parent) {
          flags = {};
          const source = await fixture.createWorktreeSession(message.parent);
          seed(source.sessionId);
          return process.send(source);
        }
        if (message.observe) return process.send({ bindings: loadBindings() });
        flags = message;
        process.send({ acknowledged: true });
      });
      process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
      const health = await fixture.get('/api/health');
      process.send({ base: new URL(health.url).origin, repo: fixture.repo, projectId: fixture.projectId, sessionId: fixture.mainSessionId });
    `], { env: { PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_WEB_UI_ONLY: "0", PI_WEB_PRESTART_COMMAND: "", PI_TEST_CONTROL: control, PI_TEST_PARENT: parentFile, PI_TEST_MARKER: marker, PI_TEST_RELEASE: release, PI_TEST_REAL_GIT: realGit }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    const [{ base, repo, projectId, sessionId }] = await Promise.race([once(child, "message"), delay(10_000).then(() => { throw new Error(`startup timeout: ${output}`); })]);
    const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const command = async message => { const reply = once(child, "message"); child.send(message); return (await reply)[0]; };
    const request = async (route, body) => { const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30_000) }); return { status: response.status, body: await response.json() }; };
    const held = async (mode, id, body, change = null) => {
      for (const file of [marker, release]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, mode);
      const operation = request(`/api/sessions/${id}/worktree`, body).then(value => ({ value }), error => ({ error })); pending.push(operation);
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(10);
      assert.ok(fs.existsSync(marker), `hold ${mode}: ${output}`);
      assert.equal((await fetch(base + '/api/health', { signal: AbortSignal.timeout(2_000) })).status, 200);
      assert.equal(fs.existsSync(release), false);
      const before = git(repo, 'show-ref');
      const busy = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(busy.status, 409); assert.equal(busy.body.error, 'repository_busy'); assert.equal(git(repo, 'show-ref'), before);
      if (change) await command(change);
      fs.writeFileSync(control, ''); fs.writeFileSync(release, 'go');
      const outcome = await operation; assert.equal(outcome.error, undefined, outcome.error?.stack || output);
      assert.equal((await request(`/api/projects/${projectId}/fetch`)).status, 200);
      return outcome.value;
    };
    for (const [mode, branch] of [['create-read', 'create-first'], ['create', 'create-second']]) {
      const result = await held(mode, sessionId, { branch });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal((await command({ observe: true })).bindings[sessionId].workspacePath, result.body.workspacePath);
    }
    const snapshot = cwd => ({ staged: git(cwd, 'diff', '--cached', '--binary'), unstaged: git(cwd, 'diff', '--binary'), status: git(cwd, 'status', '--porcelain'), untracked: fs.readFileSync(path.join(cwd, 'untracked.txt'), 'utf8') });
    let number = 0;
    const dirtyParent = async () => {
      const source = await command({ parent: `parent-${++number}` });
      const cwd = source.workspacePath;
      fs.writeFileSync(path.join(cwd, 'old.txt'), 'preexisting stash\n'); git(cwd, 'stash', 'push', '-u', '-m', `old-${number}`);
      fs.writeFileSync(path.join(cwd, 'README.md'), 'staged edit\n'); git(cwd, 'add', 'README.md');
      fs.writeFileSync(path.join(cwd, 'README.md'), 'staged edit\nunstaged edit\n'); fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'preserve untracked\n');
      fs.writeFileSync(parentFile, fs.realpathSync(cwd));
      return { ...source, before: snapshot(cwd), stashes: git(cwd, 'stash', 'list', '--format=%H') };
    };
    for (const mode of ['read', 'stash']) {
      const parent = await dirtyParent();
      const result = await held(mode, parent.sessionId, { fork: true, branch: `fork-${number}` });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(snapshot(parent.workspacePath), parent.before);
      assert.deepEqual(snapshot(result.body.workspacePath), parent.before);
      assert.equal(git(parent.workspacePath, 'stash', 'list', '--format=%H'), parent.stashes);
    }
    const refused = await dirtyParent(), refs = git(repo, 'show-ref');
    const late = await held('read', refused.sessionId, { fork: true, branch: 'late-refusal' }, { streaming: refused.sessionId });
    assert.equal(late.status, 409); assert.equal(late.body.error, 'session_streaming');
    assert.deepEqual(snapshot(refused.workspacePath), refused.before); assert.equal(git(repo, 'show-ref'), refs);
    const failure = await dirtyParent();
    const failed = await held('apply-fail', failure.sessionId, { fork: true, branch: 'apply-failure' });
    assert.equal(failed.status, 500); assert.deepEqual(snapshot(failure.workspacePath), failure.before);
    assert.equal(git(failure.workspacePath, 'stash', 'list', '--format=%H'), failure.stashes);
    assert.throws(() => git(repo, 'rev-parse', 'refs/heads/apply-failure'));
    assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('refs/heads/apply-failure'));
    const cleanup = await dirtyParent();
    await command({ badFork: true });
    const cleaned = await held('cleanup', cleanup.sessionId, { fork: true, branch: 'bad-record-cleanup' });
    assert.equal(cleaned.status, 400); assert.equal(cleaned.body.error, 'bad_fork_record');
    assert.deepEqual(snapshot(cleanup.workspacePath), cleanup.before);
    assert.throws(() => git(repo, 'rev-parse', 'refs/heads/bad-record-cleanup'));
    const restoration = await dirtyParent();
    const restored = await held('restore-fail', restoration.sessionId, { fork: true, branch: 'restore-failure' });
    assert.equal(restored.status, 409); assert.equal(restored.body.error, 'stash_restore_failed');
    assert.ok(restored.body.stashRef); assert.ok(fs.existsSync(restored.body.workspacePath));
    assert.deepEqual(snapshot(restored.body.workspacePath), restoration.before);
    assert.ok(git(repo, 'stash', 'list', '--format=%H').split('\n').includes(restored.body.stashRef));
    assert.ok(git(repo, 'stash', 'list', '--format=%H').includes(restoration.stashes));
  } finally {
    fs.writeFileSync(control, ''); fs.writeFileSync(release, 'go');
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); if (!await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) { child.kill('SIGKILL'); await exited; } }
    await Promise.allSettled(pending); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
