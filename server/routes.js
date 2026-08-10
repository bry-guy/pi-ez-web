import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import {
  chatsDir, loadBindings, loadConfig, newId, projectMode, reposRoot, resolvePath, saveBindings, saveConfig, sessionSlug, slug, worktreeRoot,
} from "./config.js";
import { chatsState, projectState, sessionWorkspace, titleOf } from "./domain.js";
import { closeSession, findProjectByWorkspace, mergeSession, sweepProject } from "./lifecycle.js";
import { hub } from "./events.js";
import * as ws from "./workspaces.js";

const err = (c, status, code, extra = {}) => c.json({ error: code, ...extra }, status);
const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

function suggestedSessionBranch(repoPath, firstMessage) {
  const base = sessionSlug(firstMessage);
  const branches = ws.listBranches(repoPath);
  if (!branches.includes(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base}.${n}`;
    if (!branches.includes(candidate)) return candidate;
  }
}

export function buildApi(sup) {
  const api = new Hono();

  // ---------- state ----------
  api.get("/state", async c => {
    const cfg = loadConfig();
    const models = await safe(() => sup.listModels(), []);
    const configuredDefault = await safe(() => sup.defaultModel(), cfg.defaultModel || null);
    const projects = [];
    for (const p of cfg.projects) {
      try { projects.push(await projectState(p, sup)); }
      catch (e) { projects.push({ id: p.id, name: p.name, repoPath: p.repoPath, error: String(e.message || e), branches: [], sessions: [], occupied: {}, worktrees: {} }); }
    }
    return c.json({
      mode: process.env.PI_WEB_MODE || "real",
      defaultModel: configuredDefault,
      models,
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      projects,
      chats: await chatsState(sup),
    });
  });

  api.get("/models", async c => c.json({ models: await sup.listModels() }));

  // ---------- SSE ----------
  api.get("/events", c =>
    streamSSE(c, async stream => {
      let open = true;
      const remove = hub.addClient(frame => { if (open) stream.writeln ? stream.write(frame) : stream.write(frame); });
      stream.onAbort(() => { open = false; remove(); });
      // keepalive
      while (open) {
        await stream.sleep(15000);
        try { await stream.write(": ping\n\n"); } catch { break; }
      }
      remove();
    })
  );

  // ---------- chats & projects ----------
  api.post("/chats", async c => {
    // Give every plain chat its own workspace. Keep chatsDir() itself as the
    // legacy parent so old shared-cwd sessions remain discoverable.
    const scratch = path.join(chatsDir(), newId("c"));
    fs.mkdirSync(scratch, { recursive: true });
    const { id } = await sup.createSession({ cwd: scratch, model: await sup.defaultModel() });
    hub.emit(id, "session_created", { session: { id, title: "New session" } });
    return c.json({ id });
  });

  api.get("/repos", c => {
    const root = c.req.query("root") ? resolvePath(c.req.query("root")) : reposRoot(loadConfig());
    return c.json({ root, repos: ws.findRepos(root).map(p => ({ path: p, name: path.basename(p) })) });
  });

  api.post("/projects", async c => {
    const { repoPath: rawPath, name } = await c.req.json();
    const repoPath = rawPath ? resolvePath(rawPath) : null;
    if (!repoPath || !ws.isGitRepo(repoPath)) return err(c, 400, "not_a_git_repo");
    const cfg = loadConfig();
    if (cfg.projects.some(p => p.repoPath === repoPath)) return err(c, 409, "project_exists");
    const project = { id: newId("p"), name: name || path.basename(repoPath), repoPath };
    cfg.projects.push(project);
    saveConfig(cfg);
    ws.prune(repoPath);
    // First session lives on the checkout's branch — the checkout is its workspace.
    const { id: sessionId } = await sup.createSession({ cwd: repoPath, model: await sup.defaultModel() });
    hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id } });
    return c.json({ id: project.id, sessionId });
  });

  api.post("/projects/:id/sessions", async c => {
    const project = loadConfig().projects.find(p => p.id === c.req.param("id"));
    if (!project) return err(c, 404, "no_such_project");
    const { id: sessionId } = await sup.createSession({ cwd: project.repoPath, model: await sup.defaultModel() });
    hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id } });
    return c.json({ id: sessionId, projectId: project.id });
  });

  api.get("/projects/:id/files", c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const branch = c.req.query("branch");
    const dir = branch ? (ws.listWorktrees(p.repoPath)[branch] || p.repoPath) : p.repoPath;
    return c.json({ tree: ws.fileTree(dir) });
  });

  // ---------- session ops ----------

  api.post("/sessions/:id/message", async c => {
    const id = c.req.param("id");
    const { text, mode = "prompt" } = await c.req.json();
    if (!text?.trim()) return err(c, 400, "empty_message");
    const cwd = await sessionWorkspace(id, sup);
    // one-active-turn-per-workspace backstop (external/legacy sessions sharing a cwd)
    const busyBy = cwd ? sup.activeInCwd(cwd, id) : null;
    if (busyBy) {
      hub.emit(id, "workspace_busy", { workspacePath: cwd, bySessionId: busyBy });
      return err(c, 409, "workspace_busy", { bySessionId: busyBy });
    }

    const bindings = loadBindings();
    if (!bindings[id]) {
      const found = cwd && findProjectByWorkspace(cwd);
      if (found && projectMode(found.project) === "auto" && cwd === found.project.repoPath) {
        const occupier = Object.entries(bindings).find(([sessionId, binding]) =>
          sessionId !== id && binding?.workspacePath === found.project.repoPath);
        if (occupier) {
          const meta = await sup.meta(occupier[0]);
          const suggestedBranch = suggestedSessionBranch(found.project.repoPath, text.trim());
          return err(c, 409, "checkout_occupied", {
            suggestedBranch, bySessionId: occupier[0], byTitle: titleOf(meta || { firstMessage: "another session" }),
          });
        }
        bindings[id] = { branch: ws.currentBranch(found.project.repoPath), workspacePath: found.project.repoPath };
        saveBindings(bindings);
      }
    }
    await sup.message(id, text.trim(), mode);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/stop", async c => {
    await sup.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/sessions/:id/transcript", async c => {
    const id = c.req.param("id");
    // Capture the sequence before reading the snapshot. Events emitted after
    // this point remain in the client's buffer and are replayed by seq.
    const seq = hub.currentSeq();
    return c.json({
      sessionId: id,
      seq,
      streaming: sup.isStreaming(id),
      records: await sup.transcript(id),
    });
  });

  api.get("/sessions/:id/meta", async c => {
    const meta = await sup.meta(c.req.param("id"));
    return meta ? c.json(meta) : err(c, 404, "no_such_session");
  });

  api.post("/sessions/:id/model", async c => {
    const { model } = await c.req.json();
    try {
      await sup.setModel(c.req.param("id"), model);
      return c.json({ ok: true, model });
    } catch (e) {
      if (e.code === "model_unavailable") return err(c, 400, "model_unavailable");
      throw e;
    }
  });

  api.post("/sessions/:id/name", async c => {
    const { name } = await c.req.json();
    await sup.setName(c.req.param("id"), name);
    return c.json({ ok: true });
  });

  // Branch switch / create: re-home the session to that branch's workspace.
  // Occupied rule: one session per workspace — moving onto a branch whose
  // worktree is bound to another session is a 409.
  api.post("/sessions/:id/branch", async c => {
    const id = c.req.param("id");
    const { branch: rawBranch, create = false } = await c.req.json();
    const branch = slug(rawBranch || "");
    if (!branch) return err(c, 400, "bad_branch");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");

    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const { project } = found;
    const cfg = loadConfig();

    if (!create && !ws.listBranches(project.repoPath).includes(branch)) return err(c, 404, "no_such_branch");
    const target = ws.ensureWorkspace({
      repoPath: project.repoPath, worktreeRoot: worktreeRoot(cfg),
      projectId: project.id, branch, fromRef: create ? "HEAD" : undefined,
    });
    if (target === cwd) return c.json({ ok: true, branch, workspacePath: target });

    // occupied?
    const bindings = loadBindings();
    for (const wt of [target]) {
      const bound = await sup.listSessions(wt);
      const boundHere = bound.filter(s => (bindings[s.id]?.workspacePath || s.cwd) === wt && s.id !== id);
      const rebound = Object.entries(bindings).find(([sid, binding]) => binding?.workspacePath === wt && sid !== id);
      const occupier = boundHere[0] || (rebound && { id: rebound[0] });
      if (occupier) return err(c, 409, "branch_occupied", { bySessionId: occupier.id, byTitle: occupier.firstMessage ? titleOf(occupier) : undefined });
    }

    await sup.rehome(id, target);
    bindings[id] = { branch, workspacePath: target };
    saveBindings(bindings);
    hub.emit(id, "session_meta", { branch });
    return c.json({ ok: true, branch, workspacePath: target });
  });

  // Fork: point-in-time conversation + code. New branch + worktree from the
  // parent workspace HEAD carrying dirty state; transcript forked at message.
  api.post("/sessions/:id/fork", async c => {
    const id = c.req.param("id");
    const { atRecordId } = await c.req.json();
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 400, "fork_requires_project");
    const { project, worktrees } = found;
    const cfg = loadConfig();
    const parentBranch = Object.entries(worktrees).find(([, p]) => p === cwd)?.[0] || ws.currentBranch(cwd);

    let branch, workspacePath;
    const forkBranchBase = projectMode(project) === "auto"
      ? sessionSlug((await sup.transcript(id)).find(record => record.role === "user")?.text)
      : undefined;
    try {
      ({ branch, workspacePath } = ws.forkWorkspace({
        repoPath: project.repoPath, worktreeRoot: worktreeRoot(cfg), projectId: project.id,
        parentWorkspace: cwd, parentBranch, existingBranches: ws.listBranches(project.repoPath), forkBranchBase,
      }));
    } catch (e) {
      if (e.code === "checkout_dirty") return err(c, 409, "checkout_dirty");
      throw e;
    }
    if (project.setup) {
      await new Promise(res => execFile("/bin/sh", ["-c", project.setup], { cwd: workspacePath }, () => res()));
    }
    let childId;
    try {
      ({ id: childId } = await sup.fork(id, atRecordId, { cwd: workspacePath }));
    } catch (e) {
      try { ws.removeWorkspace({ repoPath: project.repoPath, workspacePath, force: true }); } catch { /* best effort cleanup */ }
      try { execFileSync("git", ["branch", "-D", branch], { cwd: project.repoPath, stdio: "ignore" }); } catch { /* best effort cleanup */ }
      if (e.code === "bad_fork_record") return err(c, 400, "bad_fork_record");
      throw e;
    }
    hub.emit(childId, "session_forked", {
      session: { id: childId, branch }, parentSessionId: id, atEntryId: atRecordId,
    });
    return c.json({ id: childId, branch, workspacePath });
  });

  // Bang: user-initiated local shell in the session's workspace. Distinct from
  // agent tool calls end-to-end (orange ! rendering keyed on bang_* events).
  api.post("/sessions/:id/bang", async c => {
    const id = c.req.param("id");
    const { cmd } = await c.req.json();
    if (!cmd?.trim()) return err(c, 400, "empty_command");
    const cwd = (await sessionWorkspace(id, sup)) || chatsDir();
    // A bang is a workspace operation too; do not let it mutate a workspace
    // while another session has an active agent turn there.
    const busyBy = cwd ? sup.activeInCwd(cwd, id) : null;
    if (busyBy) {
      hub.emit(id, "workspace_busy", { workspacePath: cwd, bySessionId: busyBy });
      return err(c, 409, "workspace_busy", { bySessionId: busyBy });
    }
    const bangId = newId("bg");
    hub.emit(id, "bang_start", { bangId, cmd });
    const t0 = Date.now();
    const { exit, out } = await new Promise(resolve => {
      execFile("/bin/sh", ["-c", cmd], { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
        resolve({ exit: e ? (e.code ?? 1) : 0, out: [stdout, stderr].filter(Boolean).join("") });
      });
    });
    const durationMs = Date.now() - t0;
    const meta = `exit ${exit} · ${(durationMs / 1000).toFixed(1)}s`;
    hub.emit(id, "bang_end", { bangId, exit, durationMs, stdout: out });
    await sup.bangRecord(id, { id: bangId, role: "bang", cmd, meta, out });
    return c.json({ exit, durationMs });
  });

  // Close: checkout session -> archival only; worktree session -> DESTRUCTIVE
  // (worktree removed, branch force-deleted). Confirmation lives in the UI.
  api.post("/sessions/:id/close", async c => {
    const id = c.req.param("id");
    try {
      await closeSession(sup, hub, id);
    } catch (e) {
      if (e.code === "session_streaming") return err(c, 409, "session_streaming");
      throw e;
    }
    return c.json({ ok: true });
  });

  // Merge: land the session's branch into the checkout's branch, clean up,
  // re-home the session onto the default branch (it stays open).
  api.post("/sessions/:id/merge", async c => {
    try {
      return c.json(await mergeSession(sup, hub, c.req.param("id")));
    } catch (e) {
      const codes = { session_streaming: 409, no_project_for_session: 404, nothing_to_merge: 400, workspace_dirty: 409, checkout_dirty: 409, merge_conflict: 409 };
      if (codes[e.code]) return err(c, codes[e.code], e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
  });

  // Manual merge sweep (the periodic sweeper calls the same code).
  api.post("/projects/:id/sweep", async c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const cfg = loadConfig();
    return c.json(await sweepProject(sup, hub, p, { fetch: cfg.sweepFetch !== false }));
  });

  // ---------- workspace cleanup (no daemon: in-server job + endpoint) ----------
  api.delete("/projects/:id/branches/:branch", async c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const branch = c.req.param("branch");
    const map = ws.listWorktrees(p.repoPath);
    const wsPath = map[branch];
    if (!wsPath) return err(c, 404, "no_workspace");
    if (wsPath === p.repoPath) return err(c, 400, "cannot_remove_checkout");
    try {
      ws.removeWorkspace({ repoPath: p.repoPath, workspacePath: wsPath, force: c.req.query("force") === "1" });
    } catch (e) {
      if (e.code === "workspace_dirty") return err(c, 409, "workspace_dirty");
      throw e;
    }
    return c.json({ ok: true });
  });

  // ---------- settings ----------
  api.post("/settings", async c => {
    const body = await c.req.json();
    const cfg = loadConfig();
    if (body.defaultModel === null) cfg.defaultModel = null;
    else if (body.defaultModel !== undefined) {
      const models = await sup.listModels();
      if (!models.some(model => model.id === body.defaultModel)) return err(c, 400, "model_unavailable");
      cfg.defaultModel = body.defaultModel;
    }
    if (body.reposRoot !== undefined) {
      const value = typeof body.reposRoot === "string" ? body.reposRoot.trim() : "";
      cfg.reposRoot = value || null;
    }
    saveConfig(cfg);
    return c.json({
      ok: true,
      defaultModel: await sup.defaultModel(),
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
    });
  });

  return api;
}
