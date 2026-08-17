import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import {
  chatsDir, githubConfig, loadBindings, loadConfig, newId, normalizeHookSets, normalizeHooks, normalizePiConfig, projectMode, repositorySource, reposRoot, resolvePath, saveBindings, saveConfig, sessionSlug, slug, worktreeRoot,
} from "./config.js";
import { chatsState, projectState, reconcileBindings, sessionWorkspace, titleOf } from "./domain.js";
import { closeSession, findProjectByWorkspace, mergeSession } from "./lifecycle.js";
import { hub } from "./events.js";
import * as ws from "./workspaces.js";
import { AuthFlowManager } from "./auth-flows.js";
import { GitHubClient, GitHubDeviceFlowManager, normalizeGitHubOwner } from "./github.js";
import { cloneRepository } from "./repositories.js";
import { hookResult, projectHooks, runHook } from "./hooks.js";
import { API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID } from "./version.js";

const err = (c, status, code, extra = {}) => c.json({ error: code, ...extra }, status);
const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
const formatDuration = durationMs => durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;

// Collisions count like humans do: foo, foo-2, foo-3.
// The `.N` namespace is reserved for fork children (see forkWorkspace).
function repositorySourceState(cfg, github) {
  const status = github.status();
  return {
    default: repositorySource(cfg),
    sources: [
      { id: "local", enabled: true },
      {
        id: "github",
        enabled: true,
        configured: status.configured,
        authenticated: status.authenticated,
        credentialSource: status.credentialSource,
        account: status.account,
        owner: status.owner,
      },
      { id: "git-url", enabled: true },
    ],
  };
}

function settingsState(cfg, github) {
  const githubCfg = githubConfig(cfg);
  return {
    reposRoot: {
      value: reposRoot(cfg),
      source: process.env.PI_WEB_REPOS_ROOT ? "PI_WEB_REPOS_ROOT" : cfg.reposRoot ? "config" : "default",
      editable: !process.env.PI_WEB_REPOS_ROOT,
    },
    defaultRepositorySource: {
      value: repositorySource(cfg),
      source: process.env.PI_WEB_REPOSITORY_SOURCE ? "PI_WEB_REPOSITORY_SOURCE" : "config",
      editable: !process.env.PI_WEB_REPOSITORY_SOURCE,
    },
    githubOwner: {
      value: githubCfg.owner,
      source: process.env.PI_WEB_GITHUB_OWNER ? "PI_WEB_GITHUB_OWNER" : "config",
      editable: !process.env.PI_WEB_GITHUB_OWNER,
    },
  };
}

function suggestedSessionBranch(repoPath, firstMessage) {
  const base = sessionSlug(firstMessage);
  const branches = ws.listBranches(repoPath);
  if (!branches.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!branches.includes(candidate)) return candidate;
  }
}

export function buildApi(sup) {
  const api = new Hono();
  const authFlows = new AuthFlowManager(sup);
  const github = new GitHubClient();
  const githubFlows = new GitHubDeviceFlowManager(github);

  // ---------- state ----------
  api.get("/health", c => c.json({
    ok: true,
    apiContractVersion: API_CONTRACT_VERSION,
    buildId: BUILD_ID,
    capabilities: API_CAPABILITIES,
  }));

  api.get("/state", async c => {
    const cfg = loadConfig();
    reconcileBindings(cfg, loadBindings());
    const modelState = await safe(() => sup.modelState(), {
      models: [],
      configuredDefault: cfg.defaultModel || null,
      effectiveDefault: null,
      status: cfg.defaultModel ? "unavailable" : "automatic",
      error: { code: "model_runtime_error", message: "Could not load models." },
    });
    const models = modelState.models || [];
    const providers = await safe(() => sup.listProviders(), []);
    const piConfiguration = await safe(() => sup.piConfigurationState(), {
      config: cfg.pi,
      profile: { status: "error", source: cfg.pi.profile, error: "Could not inspect Pi configuration." },
      warnings: [],
      runtime: null,
    });
    const projects = [];
    for (const p of cfg.projects) {
      try { projects.push(await projectState(p, sup)); }
      catch (e) { projects.push({ id: p.id, name: p.name, repoPath: p.repoPath, error: String(e.message || e), branches: [], sessions: [], occupied: {}, worktrees: {} }); }
    }
    return c.json({
      apiContractVersion: API_CONTRACT_VERSION,
      buildId: BUILD_ID,
      capabilities: API_CAPABILITIES,
      mode: process.env.PI_WEB_MODE || "real",
      defaultModel: modelState.configuredDefault,
      effectiveDefaultModel: modelState.effectiveDefault,
      defaultModelStatus: modelState.status,
      modelError: modelState.error || null,
      models,
      providers,
      piConfiguration,
      repositorySources: repositorySourceState(cfg, github),
      settings: settingsState(cfg, github),
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      projects,
      chats: await chatsState(sup),
    });
  });

  api.get("/models", async c => {
    const state = await sup.modelState();
    return c.json({ models: state.models, error: state.error || null });
  });

  api.get("/providers", async c => c.json({ providers: await sup.listProviders() }));

  api.get("/repository-sources", c => c.json(repositorySourceState(loadConfig(), github)));
  api.get("/github/public-repos", async c => {
    try {
      return c.json(await github.listPublicRepositories({
        owner: c.req.query("owner"),
        query: c.req.query("q"),
        page: c.req.query("page"),
      }));
    } catch (e) {
      const statuses = { github_owner_required: 400, invalid_github_owner: 400, github_not_found: 404, github_rate_limited: 403, github_unavailable: 502 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      throw e;
    }
  });
  api.get("/github/repos", async c => {
    try {
      return c.json(await github.listRepositories({ query: c.req.query("q"), page: c.req.query("page") }));
    } catch (e) {
      const statuses = { github_auth_required: 401, github_rate_limited: 403, github_unavailable: 502 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      throw e;
    }
  });
  api.post("/github/device-login", async c => {
    try { return c.json({ flow: githubFlows.view(await githubFlows.start()) }, 202); }
    catch (e) {
      const statuses = { github_not_configured: 409, github_flow_active: 409, github_login_unavailable: 502, github_unavailable: 502 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      throw e;
    }
  });
  api.get("/github/device-login/:id", c => {
    try { return c.json({ flow: githubFlows.view(githubFlows.get(c.req.param("id"))) }); }
    catch (e) { if (e.code === "no_such_github_flow") return err(c, 404, e.code); throw e; }
  });
  api.delete("/github/device-login/:id", c => {
    try { githubFlows.cancel(c.req.param("id")); return c.json({ ok: true }); }
    catch (e) { if (e.code === "no_such_github_flow") return err(c, 404, e.code); throw e; }
  });
  api.post("/github/logout", c => {
    try { github.logout(); return c.json({ ok: true }); }
    catch (e) { if (e.code === "credential_managed_by_environment") return err(c, 409, e.code); throw e; }
  });

  api.post("/providers/:id/login", async c => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const flow = await authFlows.start(c.req.param("id"), body.type);
      return c.json({ flow: flow.view() }, 202);
    } catch (e) {
      const statuses = { no_such_provider: 404, unsupported_auth_type: 400, auth_flow_active: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code);
      throw e;
    }
  });

  api.get("/auth-flows/:id", c => {
    try { return c.json({ flow: authFlows.get(c.req.param("id")).view() }); }
    catch (e) {
      if (e.code === "no_such_auth_flow") return err(c, 404, e.code);
      throw e;
    }
  });

  api.post("/auth-flows/:id/input", async c => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const flow = authFlows.get(c.req.param("id"));
      flow.submit(body.promptId, body.value);
      return c.json({ flow: flow.view() }, 202);
    } catch (e) {
      const statuses = { no_such_auth_flow: 404, stale_auth_prompt: 409, invalid_auth_option: 400 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code);
      throw e;
    }
  });

  api.delete("/auth-flows/:id", c => {
    try {
      const flow = authFlows.get(c.req.param("id"));
      flow.cancel();
      return c.json({ ok: true });
    } catch (e) {
      if (e.code === "no_such_auth_flow") return err(c, 404, e.code);
      throw e;
    }
  });

  api.post("/providers/:id/logout", async c => {
    try {
      await sup.logoutProvider(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      if (e.code === "credential_managed_by_environment") return err(c, 409, e.code);
      throw e;
    }
  });

  // ---------- SSE ----------
  api.get("/events", c =>
    streamSSE(c, async stream => {
      let open = true;
      const remove = hub.addClient(frame => { if (open) stream.write(frame); });
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
    const { id } = await sup.createSession({ cwd: scratch });
    hub.emit(id, "session_created", { session: { id, title: "New session" } });
    return c.json({ id });
  });

  api.get("/repos", c => {
    const root = c.req.query("root") ? resolvePath(c.req.query("root")) : reposRoot(loadConfig());
    return c.json({ root, repos: ws.findRepos(root).map(p => ({ path: p, name: path.basename(p) })) });
  });

  api.post("/projects", async c => {
    const body = await c.req.json();
    const cfg = loadConfig();
    const source = body.source || (body.repoPath ? "local" : repositorySource(cfg));
    let repoPath = null;
    let sourceInfo = { type: "local" };
    let cloned = false;
    if (source === "local") {
      repoPath = body.repoPath ? resolvePath(body.repoPath) : null;
      if (!repoPath || !ws.isGitRepo(repoPath)) return err(c, 400, "not_a_git_repo");
    } else {
      try {
        const result = await cloneRepository({
          source,
          url: body.url,
          fullName: body.fullName,
          github,
          root: reposRoot(cfg),
          signal: c.req.raw?.signal,
        });
        repoPath = result.repoPath;
        sourceInfo = result.source;
        cloned = result.cloned;
      } catch (e) {
        const statuses = {
          github_auth_required: 401,
          github_not_configured: 409,
          github_not_found: 404,
          github_rate_limited: 403,
          github_unavailable: 502,
          invalid_github_repository: 400,
          invalid_git_url: 400,
          invalid_repository_name: 400,
          unsupported_repository_source: 400,
          repository_exists: 409,
          clone_in_progress: 409,
          clone_failed: 502,
        };
        if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.code === "clone_failed" ? { message: e.message } : {});
        throw e;
      }
    }
    if (cfg.projects.some(p => p.repoPath === repoPath)) return err(c, 409, "project_exists");
    const project = {
      id: newId("p"), name: body.name || path.basename(repoPath), repoPath, source: sourceInfo,
      hooks: normalizeHooks(body.hooks),
      mode: body.mode === "auto" || body.mode === "manual" ? body.mode : undefined,
    };
    cfg.projects.push(project);
    saveConfig(cfg);
    ws.prune(repoPath);
    // First session lives on the checkout's branch — the checkout is its workspace.
    const { id: sessionId } = await sup.createSession({ cwd: repoPath });
    hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id } });
    const setup = projectHooks(cfg, project).setup;
    const setupResult = setup ? hookResult(await runHook(setup, { cwd: repoPath }), "setup") : null;
    return c.json({ id: project.id, sessionId, repoPath, cloned, setup: setupResult });
  });

  api.post("/projects/:id/sessions", async c => {
    const project = loadConfig().projects.find(p => p.id === c.req.param("id"));
    if (!project) return err(c, 404, "no_such_project");
    const { id: sessionId } = await sup.createSession({ cwd: project.repoPath });
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

  api.get("/sessions/:id/commands", async c => {
    try { return c.json({ commands: await sup.commands(c.req.param("id")) }); }
    catch (e) {
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/command", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    const mode = body?.mode || "prompt";
    if (!text.trim().startsWith("/")) return err(c, 400, "invalid_slash_command");
    const cwd = await sessionWorkspace(id, sup);
    const busyBy = cwd ? sup.activeInCwd(cwd, id) : null;
    if (busyBy) return err(c, 409, "workspace_busy", { bySessionId: busyBy });
    try {
      const result = await sup.command(id, text.trim(), mode);
      if (result.action === "settings") return c.json({ ok: true, action: "settings" });
      return c.json({ ok: true, ...result });
    } catch (e) {
      const statuses = { model_required: 409, unknown_slash_command: 400, invalid_slash_command: 400, command_usage: 400 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/message", async c => {
    const id = c.req.param("id");
    const { text, mode = "prompt", images = [] } = await c.req.json();
    const messageText = typeof text === "string" ? text.trim() : "";
    if (!messageText && !Array.isArray(images)) return err(c, 400, "empty_message");
    if (!messageText && images.length === 0) return err(c, 400, "empty_message");
    if (!Array.isArray(images) || images.length > 4 || images.some(image =>
      image?.type !== "image" || typeof image.data !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType || "") ||
      image.data.length > 8_000_000
    )) return err(c, 400, "invalid_images");
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
          const suggestedBranch = suggestedSessionBranch(found.project.repoPath, messageText);
          return err(c, 409, "checkout_occupied", {
            suggestedBranch, bySessionId: occupier[0], byTitle: titleOf(meta || { firstMessage: "another session" }),
          });
        }
        bindings[id] = { branch: ws.currentBranch(found.project.repoPath), workspacePath: found.project.repoPath };
        saveBindings(bindings);
      }
    }
    try {
      await sup.message(id, messageText, mode, images);
      return c.json({ ok: true });
    } catch (e) {
      if (e.code === "model_required") {
        return err(c, 409, "model_required", {
          message: "Connect a provider or choose an available model.",
        });
      }
      throw e;
    }
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

  api.get("/sessions/:id/context", async c => c.json(await sup.context(c.req.param("id"))));

  api.get("/sessions/:id/thinking", async c => c.json(await sup.thinking(c.req.param("id"))));
  api.post("/sessions/:id/thinking", async c => {
    const { level } = await c.req.json();
    return c.json(await sup.setThinking(c.req.param("id"), level));
  });

  api.post("/sessions/:id/name", async c => {
    const { name } = await c.req.json();
    await sup.setName(c.req.param("id"), name);
    return c.json({ ok: true, name: String(name || "").trim() || null });
  });

  // Branch switch / create: re-home the session to that branch's workspace.
  // Occupied rule: one session per workspace — moving onto a branch whose
  // worktree is bound to another session is a 409.
  api.post("/sessions/:id/branch", async c => {
    const id = c.req.param("id");
    const { branch: rawBranch, create = false, fromRef = null } = await c.req.json();
    const branch = slug(rawBranch || "");
    if (!branch) return err(c, 400, "bad_branch");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");

    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const { project } = found;
    const cfg = loadConfig();

    const localBranches = ws.listBranches(project.repoPath);
    const remoteBranches = ws.listRemoteBranches(project.repoPath);
    const remoteSource = fromRef || null;
    if (!create && !localBranches.includes(branch)) return err(c, 404, "no_such_branch");
    if (remoteSource && (!create || !remoteBranches.includes(remoteSource))) return err(c, 400, "invalid_remote_branch");
    if (remoteSource && localBranches.includes(branch)) return err(c, 409, "branch_exists");
    if (create && !remoteSource && !localBranches.includes(branch)) {
      const matchingRemote = ws.remoteBranchForLocal(project.repoPath, branch);
      if (matchingRemote) return err(c, 409, "branch_exists", { remoteBranch: matchingRemote });
    }
    const existingTarget = ws.listWorktrees(project.repoPath)[branch] || null;
    const target = ws.ensureWorkspace({
      repoPath: project.repoPath, worktreeRoot: worktreeRoot(cfg),
      projectId: project.id, branch, fromRef: create ? (fromRef || "HEAD") : undefined,
    });
    if (target === cwd) return c.json({ ok: true, branch, workspacePath: target, setup: null });

    // occupied?
    const bindings = loadBindings();
    const bound = await sup.listSessions(target);
    const boundHere = bound.filter(s => (bindings[s.id]?.workspacePath || s.cwd) === target && s.id !== id);
    const rebound = Object.entries(bindings).find(([sid, binding]) => binding?.workspacePath === target && sid !== id);
    const occupier = boundHere[0] || (rebound && { id: rebound[0] });
    if (occupier) return err(c, 409, "branch_occupied", { bySessionId: occupier.id, byTitle: occupier.firstMessage ? titleOf(occupier) : undefined });

    await sup.rehome(id, target);
    bindings[id] = { branch, workspacePath: target };
    saveBindings(bindings);
    hub.emit(id, "session_meta", { branch });
    const setup = !existingTarget && projectHooks(cfg, project).setup;
    const setupResult = setup ? hookResult(await runHook(setup, { cwd: target }), "setup") : null;
    return c.json({ ok: true, branch, workspacePath: target, setup: setupResult });
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
    const setup = projectHooks(cfg, project).setup;
    const setupResult = setup ? hookResult(await runHook(setup, { cwd: workspacePath }), "setup") : null;
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
    return c.json({ id: childId, branch, workspacePath, setup: setupResult });
  });

  // Configured project hooks run in the current session workspace. Hook names
  // are deployment-defined; this endpoint does not invent a fixed vocabulary.
  api.post("/sessions/:id/hooks/:name", async c => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const cwd = await sessionWorkspace(id, sup);
    if (!cwd) return err(c, 404, "no_workspace");
    const found = findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const command = projectHooks(loadConfig(), found.project)[name];
    if (!command) return err(c, 404, "no_such_hook");
    const result = hookResult(await runHook(command, { cwd }), name);
    return c.json(result);
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
    const meta = `exit ${exit} · ${formatDuration(durationMs)}`;
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
    let nextPiConfiguration;
    if (body.pi !== undefined) {
      try {
        nextPiConfiguration = normalizePiConfig(body.pi, { strict: true });
        sup.assertPiConfigurationReloadable();
      } catch (e) {
        if (e.code === "invalid_pi_configuration") return err(c, 400, e.code, { message: e.message });
        if (e.code === "pi_configuration_busy") return err(c, 409, e.code);
        throw e;
      }
      cfg.pi = nextPiConfiguration;
    }
    if (body.defaultModel === null) cfg.defaultModel = null;
    else if (body.defaultModel !== undefined) {
      const models = await sup.listModels();
      if (!models.some(model => model.id === body.defaultModel)) return err(c, 400, "model_unavailable");
      cfg.defaultModel = body.defaultModel;
    }
    if (body.reposRoot !== undefined) {
      if (process.env.PI_WEB_REPOS_ROOT) return err(c, 409, "setting_overridden", { field: "reposRoot", source: "PI_WEB_REPOS_ROOT" });
      const value = typeof body.reposRoot === "string" ? body.reposRoot.trim() : "";
      cfg.reposRoot = value || null;
    }
    if (body.defaultRepositorySource !== undefined) {
      if (process.env.PI_WEB_REPOSITORY_SOURCE) return err(c, 409, "setting_overridden", { field: "defaultRepositorySource", source: "PI_WEB_REPOSITORY_SOURCE" });
      if (!["local", "github", "git-url"].includes(body.defaultRepositorySource)) return err(c, 400, "invalid_repository_source");
      cfg.repositorySources.default = body.defaultRepositorySource;
    }
    if (body.githubOwner !== undefined) {
      if (process.env.PI_WEB_GITHUB_OWNER) return err(c, 409, "setting_overridden", { field: "githubOwner", source: "PI_WEB_GITHUB_OWNER" });
      try {
        cfg.repositorySources.github.owner = normalizeGitHubOwner(body.githubOwner);
      } catch (e) {
        if (e.code === "invalid_github_owner") return err(c, 400, e.code, { message: e.message });
        throw e;
      }
    }
    if (body.projectHookSets !== undefined) {
      if (!body.projectHookSets || typeof body.projectHookSets !== "object" || Array.isArray(body.projectHookSets)) return err(c, 400, "invalid_project_hook_sets");
      cfg.projectHookSets = normalizeHookSets(body.projectHookSets);
    }
    saveConfig(cfg);
    const piConfiguration = nextPiConfiguration
      ? await sup.reloadPiConfiguration()
      : await sup.piConfigurationState();
    const modelState = await sup.modelState();
    return c.json({
      ok: true,
      apiContractVersion: API_CONTRACT_VERSION,
      buildId: BUILD_ID,
      capabilities: API_CAPABILITIES,
      defaultModel: modelState.configuredDefault,
      effectiveDefaultModel: modelState.effectiveDefault,
      defaultModelStatus: modelState.status,
      modelError: modelState.error || null,
      piConfiguration,
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      repositorySources: repositorySourceState(cfg, github),
      settings: settingsState(cfg, github),
    });
  });

  return api;
}
