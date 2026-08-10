// Lifecycle: explicit close (worktree removed, branch + transcript kept) and
// the merge sweep (merged + clean + idle -> session closed, worktree removed,
// branch deleted; dirty/unmerged/streaming -> untouched).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let base, server, home, tmp, repo, projectId, mainSessionId;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const J = { "content-type": "application/json" };
const post = (p, b) => fetch(base + p, { method: "POST", headers: J, body: JSON.stringify(b ?? {}) });
const get = p => fetch(base + p);
const state = async () => (await (await get("/api/state")).json());
const proj = async () => (await state()).projects.find(x => x.id === projectId);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-life-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A"); git(repo, "commit", "-m", "init");

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ worktreeRoot: path.join(home, "worktrees") }));
  process.env.PI_WEB_HOME = home;
  process.env.PI_WEB_MODE = "mock";
  process.env.PI_WEB_MOCK_THINK_MS = "120";
  process.env.PI_WEB_MOCK_DELTA_MS = "5";

  const { startServer } = await import("../server/index.js");
  ({ server } = startServer(0));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await (await post("/api/projects", { repoPath: repo })).json();
  projectId = res.id;
  mainSessionId = res.sessionId;
});
after(() => {
  server?.closeAllConnections?.();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("close a worktree session: destructive — worktree AND branch removed, transcript kept", async () => {
  await post(`/api/sessions/${mainSessionId}/branch`, { branch: "feat/throwaway", create: true });
  const p1 = await proj();
  const wt = p1.worktrees["feat/throwaway"];
  fs.writeFileSync(path.join(wt, "junk.txt"), "uncommitted junk\n"); // dirty: still closes, no handshake

  const r = await post(`/api/sessions/${mainSessionId}/close`);
  assert.equal(r.status, 200);

  const p2 = await proj();
  assert.equal(fs.existsSync(wt), false);                        // worktree gone
  assert.equal(p2.branches.includes("feat/throwaway"), false);   // branch force-deleted
  assert.equal(JSON.stringify(p2.sessions).includes(mainSessionId), false); // hidden
  const snap = await (await get(`/api/sessions/${mainSessionId}/transcript`)).json();
  assert.ok(Array.isArray(snap.records));                        // transcript survives
});

// helper: fabricate an externally created session homed in the checkout (pi CLI style)
async function checkoutSession() {
  const mk = await (await post("/api/chats")).json();
  const f = path.join(home, "mock-sessions", mk.id + ".json");
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  m.cwd = repo;
  fs.writeFileSync(f, JSON.stringify(m));
  return mk.id;
}

test("close a checkout session: archival only — nothing in git is touched", async () => {
  const id = await checkoutSession();
  const before = git(repo, "rev-parse", "HEAD").trim();
  const r = await post(`/api/sessions/${id}/close`);
  assert.equal(r.status, 200);
  const p = await proj();
  assert.ok(p.branches.includes("main"));
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), before);
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  assert.equal(JSON.stringify(p.sessions).includes(id), false);
});

test("merge: lands work into the checkout, cleans up, session continues on the default branch", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/ship", create: true });
  const wt = (await proj()).worktrees["feat/ship"];
  fs.writeFileSync(path.join(wt, "feature.txt"), "shipped\n");
  git(wt, "add", "-A"); git(wt, "commit", "-m", "feature");

  const r = await post(`/api/sessions/${id}/merge`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.merged, "feat/ship");
  assert.equal(body.into, "main");

  // work landed via a merge commit in the checkout
  assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "shipped\n");
  assert.match(git(repo, "log", "-1", "--format=%s"), /Merge feat\/ship/);
  // cleanup
  const p = await proj();
  assert.equal(fs.existsSync(wt), false);
  assert.equal(p.branches.includes("feat/ship"), false);
  // session still open, now on main (occupied-exemption: co-homed on checkout)
  assert.ok(JSON.stringify(p.sessions).includes(id));
  const node = p.sessions.find(n => n.id === id) || p.sessions.flatMap(n => n.children).find(n => n?.id === id);
  assert.equal(node.branch, "main");
  // and it can keep working: send a turn in the checkout
  await post(`/api/sessions/${id}/message`, { text: "hello from main" });
  await post(`/api/sessions/${id}/stop`);
});

test("merge preflight: dirty worktree is refused (merge stays safe)", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/dirty-merge", create: true });
  const wt = (await proj()).worktrees["feat/dirty-merge"];
  fs.writeFileSync(path.join(wt, "wip.txt"), "uncommitted\n");
  const r = await post(`/api/sessions/${id}/merge`);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "workspace_dirty");
  assert.ok(fs.existsSync(wt)); // untouched
  await post(`/api/sessions/${id}/close`); // cleanup (destructive close)
});

test("merge preflight: dirty checkout is refused", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/co-dirty", create: true });
  const wt = (await proj()).worktrees["feat/co-dirty"];
  fs.writeFileSync(path.join(wt, "ok.txt"), "ok\n");
  git(wt, "add", "-A"); git(wt, "commit", "-m", "ok");
  fs.writeFileSync(path.join(repo, "local-edit.txt"), "user was here\n"); // checkout dirty
  const r = await post(`/api/sessions/${id}/merge`);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "checkout_dirty");
  fs.rmSync(path.join(repo, "local-edit.txt"));
  await post(`/api/sessions/${id}/close`);
});

test("merge conflict: aborted cleanly — checkout restored, branch and worktree untouched", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/conflict", create: true });
  const wt = (await proj()).worktrees["feat/conflict"];
  // both sides edit the same line of README.md
  fs.writeFileSync(path.join(wt, "README.md"), "branch version\n");
  git(wt, "add", "-A"); git(wt, "commit", "-m", "branch side");
  fs.writeFileSync(path.join(repo, "README.md"), "main version\n");
  git(repo, "add", "-A"); git(repo, "commit", "-m", "main side");

  const r = await post(`/api/sessions/${id}/merge`);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "merge_conflict");
  // checkout fully restored
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "main version\n");
  // branch + worktree survive for manual resolution
  const p = await proj();
  assert.ok(p.branches.includes("feat/conflict"));
  assert.ok(fs.existsSync(wt));
  await post(`/api/sessions/${id}/close`);
});

test("merge from a checkout session is nothing_to_merge", async () => {
  const id = await checkoutSession();
  const r = await post(`/api/sessions/${id}/merge`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "nothing_to_merge");
  await post(`/api/sessions/${id}/close`);
});

test("closing a parent re-attaches its child at the visible tree position", async () => {
  const parent = await checkoutSession();
  const fork = await (await post(`/api/sessions/${parent}/fork`, {})).json();
  await post(`/api/sessions/${parent}/close`);
  const p = await proj();
  assert.ok(p.sessions.some(node => node.id === fork.id), JSON.stringify(p.sessions));
  await post(`/api/sessions/${fork.id}/close`);
});

test("merge sweep still reaps CLI-side merges (merged+clean+idle)", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/cli-merged", create: true });
  const wt = (await proj()).worktrees["feat/cli-merged"];
  fs.writeFileSync(path.join(wt, "cli.txt"), "cli\n");
  git(wt, "add", "-A"); git(wt, "commit", "-m", "cli");
  git(repo, "merge", "--no-ff", "feat/cli-merged", "-m", "merged by hand");
  const sweep = await (await post(`/api/projects/${projectId}/sweep`)).json();
  assert.ok(sweep.reaped.some(x => x.branch === "feat/cli-merged"), JSON.stringify(sweep));
  const p = await proj();
  assert.equal(fs.existsSync(wt), false);
  assert.equal(p.branches.includes("feat/cli-merged"), false);
});

test("sweep skips dirty worktrees and streaming sessions", async () => {
  const id = await checkoutSession();
  await post(`/api/sessions/${id}/branch`, { branch: "feat/skip-dirty", create: true });
  const wt = (await proj()).worktrees["feat/skip-dirty"];
  fs.writeFileSync(path.join(wt, "d.txt"), "d\n");
  git(wt, "add", "-A"); git(wt, "commit", "-m", "d");
  git(repo, "merge", "--no-ff", "feat/skip-dirty", "-m", "merged");
  fs.writeFileSync(path.join(wt, "leftover.txt"), "uncommitted\n");
  const s1 = await (await post(`/api/projects/${projectId}/sweep`)).json();
  assert.ok(s1.skipped.some(x => x.branch === "feat/skip-dirty" && x.reason === "dirty"), JSON.stringify(s1));
  fs.rmSync(path.join(wt, "leftover.txt"));

  await post(`/api/sessions/${id}/message`, { text: "thinking" });
  const s2 = await (await post(`/api/projects/${projectId}/sweep`)).json();
  assert.ok(s2.skipped.some(x => x.branch === "feat/skip-dirty" && x.reason === "streaming"), JSON.stringify(s2));
  await post(`/api/sessions/${id}/stop`);
  const s3 = await (await post(`/api/projects/${projectId}/sweep`)).json();
  assert.ok(s3.reaped.some(x => x.branch === "feat/skip-dirty"), JSON.stringify(s3));
});
