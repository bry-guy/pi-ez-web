import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadBindings } from "../server/config.js";
import { withRepositoryAdmission } from "../server/repository-admission.js";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

async function waitFor(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for the held operation.")), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

function projectBindings(projectId) {
  return Object.fromEntries(Object.entries(loadBindings()).filter(([, binding]) => binding.projectId === projectId));
}

test("repository admission serializes every Git-mutating route for one repository", async () => {
  const fixture = await createIsolatedServerFixture();
  try {
    const other = await fixture.createProject({ repoPath: fixture.makeRepo("other-repository") });
    fixture.git(fixture.repo, "branch", "admission-delete");
    const originalCreateSession = fixture.supervisor.createSession.bind(fixture.supervisor);
    let release;
    let markStarted;
    let paused = false;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.supervisor.createSession = async options => {
      if (!paused) {
        paused = true;
        markStarted();
        await gate;
      }
      return originalCreateSession(options);
    };
    const held = fixture.post(`/api/projects/${fixture.projectId}/sessions`, { branch: "main" }).then(response => ({ response }), error => ({ error }));
    try {
      await waitFor(started);
      const snapshot = () => ({
        refs: fixture.git(fixture.repo, "show-ref"),
        status: fixture.git(fixture.repo, "status", "--porcelain", "--untracked-files=all"),
        files: fixture.git(fixture.repo, "ls-files", "-z").split("\0").filter(Boolean).map(file => [file, fs.readFileSync(path.join(fixture.repo, file), "utf8")]),
        bindings: projectBindings(fixture.projectId),
      });
      const before = snapshot();
      const sessionId = fixture.mainSessionId;
      const responses = await Promise.all([
        fixture.post(`/api/projects/${fixture.projectId}/fetch`, {}),
        fixture.post(`/api/projects/${fixture.projectId}/sessions`, { branch: "main" }),
        fixture.post(`/api/sessions/${sessionId}/branch-context`, { branch: "admission-context" }),
        fixture.post(`/api/sessions/${sessionId}/worktree`, { branch: "admission-worktree" }),
        fixture.post(`/api/sessions/${sessionId}/switch`, { branch: "main" }),
        fixture.post(`/api/sessions/${sessionId}/pull`, {}),
        fixture.post(`/api/sessions/${sessionId}/push`, {}),
        fixture.post(`/api/sessions/${sessionId}/merge-local`, {}),
        fixture.remove(`/api/projects/${fixture.projectId}/branches/admission-delete`),
      ]);
      for (const response of responses) {
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error, "repository_busy");
      }
      const independent = await fixture.post(`/api/projects/${other.id}/sessions`, { branch: "main" });
      assert.equal(independent.status, 200, await independent.clone().text());
      assert.deepEqual(snapshot(), before);
      release();
      const result = await held;
      assert.equal(result.error, undefined);
      assert.equal(result.response.status, 200, await result.response.clone().text());
      const afterRelease = await fixture.post(`/api/projects/${fixture.projectId}/sessions`, { branch: "main" });
      assert.equal(afterRelease.status, 200, await afterRelease.clone().text());
    } finally {
      release();
      fixture.supervisor.createSession = originalCreateSession;
    }
  } finally {
    await fixture.close();
  }
});

test("common Git directory aliases share admission and all exits release it", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const symlink = path.join(fixture.tmp, "repo-link");
    const linkedWorktree = path.join(fixture.tmp, "linked-worktree");
    fs.symlinkSync(fixture.repo, symlink, "dir");
    execFileSync("git", ["worktree", "add", "-b", "admission-alias", linkedWorktree, "HEAD"], { cwd: fixture.repo, stdio: "ignore" });
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const held = withRepositoryAdmission(fixture.repo, async () => { markStarted(); await gate; });
    try {
      await waitFor(started);
      await assert.rejects(withRepositoryAdmission(symlink, async () => {}), error => error.code === "repository_busy");
    } finally {
      release();
      await held;
    }
    let releaseLinked;
    let markLinkedStarted;
    const linkedStarted = new Promise(resolve => { markLinkedStarted = resolve; });
    const linkedGate = new Promise(resolve => { releaseLinked = resolve; });
    const heldLinked = withRepositoryAdmission(linkedWorktree, async () => { markLinkedStarted(); await linkedGate; });
    try {
      await waitFor(linkedStarted);
      await assert.rejects(withRepositoryAdmission(fixture.repo, async () => {}), error => error.code === "repository_busy");
    } finally {
      releaseLinked();
      await heldLinked;
    }
    await assert.rejects(withRepositoryAdmission(linkedWorktree, async () => { throw new Error("expected"); }), /expected/);
    assert.equal(await withRepositoryAdmission(fixture.repo, async () => "released"), "released");
    const response = new Response("early");
    assert.equal(await withRepositoryAdmission(fixture.repo, async () => response), response);
    assert.equal(await withRepositoryAdmission(linkedWorktree, async () => "released"), "released");
  } finally {
    fixture.close();
  }
});
