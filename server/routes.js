import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import {
  chatsDir, githubConfig, loadBindings, loadConfig, newId, normalizeHookSets, normalizeHooks, normalizePiConfig, normalizeSyncConfig, normalizeThinkingLevel, repositorySource, reposRoot, resolvePath, saveBindings, saveConfig, sessionSlug, slug, syncConfig, syncSettingsState, worktreeRoot,
} from "./config.js";
import { chatsState, projectState, reconcileBindings, sessionWorkspace, sessionsUsingWorkspace } from "./domain.js";
import { closeSession, findProjectByWorkspace, mergeSession, returnSessionToMain } from "./lifecycle.js";
import { hub } from "./events.js";
import * as ws from "./workspaces.js";
import { AuthFlowManager } from "./auth-flows.js";
import { GitHubClient, GitHubDeviceFlowManager, normalizeGitHubOwner } from "./github.js";
import { cloneRepository } from "./repositories.js";
import { NO_DIFF_TARGET, readFileTree, readFileView } from "./file-explorer.js";
import { hookResult, projectHooks, runHook } from "./hooks.js";
import { API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID } from "./version.js";
import { createSyncCoordinator } from "./sync/coordinator.js";
import { markSyncEnrolled, markSyncPending } from "./sync/enrollment.js";

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
    sync: syncSettingsState(cfg),
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

async function suggestedWorktreeBranch(repoPath, sessionId, sup) {
  const records = await sup.transcript(sessionId);
  const firstMessage = records.find(record => record.role === "user")?.text || "";
  const base = sessionSlug(firstMessage);
  const branches = ws.listBranches(repoPath);
  if (!branches.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!branches.includes(candidate)) return candidate;
  }
}

async function hasSynchronizedSibling(sessions, currentId, sync) {
  for (const session of sessions || []) {
    if (session.id === currentId) continue;
    if ((await sync.status(session.id)).synchronized) return true;
  }
  return false;
}

function projectContext(project, requestedId) {
  const contexts = ws.listContexts(project.repoPath);
  if (requestedId) return contexts.find(context => context.id === String(requestedId)) || null;
  return contexts.find(context => path.resolve(context.path) === path.resolve(project.repoPath)) || contexts[0] || null;
}

function requestedContext(project, c) {
  if (c.req.query("contextId")) return projectContext(project, c.req.query("contextId"));
  const branch = c.req.query("branch");
  if (branch) return ws.listContexts(project.repoPath).find(context => context.branch === branch) || null;
  return projectContext(project, null);
}

function bindSessionToContext(sessionId, project, context) {
  const bindings = loadBindings();
  bindings[sessionId] = { projectId: project.id, workspacePath: context.path };
  saveBindings(bindings);
}

function branchContext(project, branch) {
  const contexts = ws.listContexts(project.repoPath).filter(context => context.branch === branch);
  return contexts.find(context => context.kind === "checkout") || contexts[0] || null;
}

async function ensureBranchContext(project, branch, baseBranch = ws.MAIN_BRANCH, { syncMain = true } = {}) {
  branch = ws.validateBranchName(branch || ws.MAIN_BRANCH);
  baseBranch = ws.validateBranchName(baseBranch || ws.MAIN_BRANCH);
  if (branch === ws.MAIN_BRANCH) {
    ws.prepareMain(project.repoPath, { fetch: false });
    return branchContext(project, branch) || ws.contextStatus({ repoPath: project.repoPath, workspacePath: project.repoPath });
  }
  const existing = branchContext(project, branch);
  if (existing) return existing;
  const branches = ws.listBranches(project.repoPath);
  if (!branches.includes(branch) && baseBranch === ws.MAIN_BRANCH && syncMain) ws.prepareMain(project.repoPath, { fetch: true });
  if (!ws.listBranches(project.repoPath).includes(baseBranch)) throw Object.assign(new Error("no_such_base_branch"), { code: "no_such_base_branch" });
  const cfg = loadConfig();
  const workspacePath = ws.ensureWorkspace({
    repoPath: project.repoPath,
    worktreeRoot: worktreeRoot(cfg),
    projectId: project.id,
    branch,
    fromRef: baseBranch,
  });
  const context = branchContext(project, branch);
  return context || ws.contextStatus({ repoPath: project.repoPath, workspacePath });
}

async function sessionBelongsToProject(id, project, sup) {
  const cwd = await sessionWorkspace(id, sup);
  if (!cwd) return false;
  const found = findProjectByWorkspace(cwd);
  return found?.project?.id === project.id;
}

export function buildApi(sup, { syncCoordinator = null } = {}) {
  const api = new Hono();
  const sync = syncCoordinator || createSyncCoordinator({ supervisor: sup, configProvider: loadConfig });
  sup.setSyncCoordinator?.(sync);
  const mutate = (id, task, options = {}) => typeof sync.withMutation === "function"
    ? sync.withMutation(id, task, options)
    : task();
  const beginStreamingMutation = id => typeof sync.beginMutation === "function"
    ? sync.beginMutation(id, { allowStreaming: true })
    : { managed: false };
  const finishStreamingMutation = async (id, lease) => {
    if (lease?.managed) await sync.commitSettled?.(id, lease);
  };
  const authFlows = new AuthFlowManager(sup);
  const github = new GitHubClient();
  const githubFlows = new GitHubDeviceFlowManager(github);

  // ---------- state ----------
  api.get("/health", c => c.json({
    ok: true,
    apiContractVersion: API_CONTRACT_VERSION,
    buildId: BUILD_ID,
    capabilities: API_CAPABILITIES,
    sync: sync.state(),
  }));

  api.get("/state", async c => {
    const cfg = loadConfig();
    void sync.reconcile?.();
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
      try { projects.push(await projectState(p, sup, sync)); }
      catch (e) { projects.push({ id: p.id, name: p.name, repoPath: p.repoPath, error: String(e.message || e), branches: [], sessions: [], contexts: [], worktrees: {}, workspaceStatus: {} }); }
    }
    return c.json({
      apiContractVersion: API_CONTRACT_VERSION,
      buildId: BUILD_ID,
      capabilities: API_CAPABILITIES,
      mode: process.env.PI_WEB_MODE || "real",
      defaultModel: modelState.configuredDefault,
      defaultThinkingLevel: cfg.defaultThinkingLevel,
      effectiveDefaultModel: modelState.effectiveDefault,
      defaultModelStatus: modelState.status,
      modelError: modelState.error || null,
      models,
      providers,
      piConfiguration,
      repositorySources: repositorySourceState(cfg, github),
      settings: settingsState(cfg, github),
      sync: sync.state(),
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      projects,
      chats: await chatsState(sup, sync),
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
    };
    cfg.projects.push(project);
    saveConfig(cfg);
    // First session runs in the repository checkout; Git state remains user-owned.
    const { id: sessionId } = await sup.createSession({ cwd: repoPath });
    const context = projectContext(project, null);
    if (context) bindSessionToContext(sessionId, project, context);
    hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id, contextId: context?.id || null } });
    const setup = projectHooks(cfg, project).setup;
    const setupResult = setup ? hookResult(await runHook(setup, { cwd: repoPath }), "setup") : null;
    return c.json({ id: project.id, sessionId, repoPath, cloned, contextId: context?.id || null, branch: context?.branch || null, setup: setupResult });
  });

  api.post("/projects/:id/sessions", async c => {
    const project = loadConfig().projects.find(p => p.id === c.req.param("id"));
    if (!project) return err(c, 404, "no_such_project");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const mode = body.mode === "fork" ? "fork" : "new";
    let branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
    const legacyContext = body.contextId ? projectContext(project, body.contextId) : null;
    if (!branch && legacyContext) branch = legacyContext.branch;
    branch ||= ws.MAIN_BRANCH;
    try {
      const existed = !!branchContext(project, branch);
      const context = await ensureBranchContext(project, branch, body.baseBranch || ws.MAIN_BRANCH, { syncMain: true });
      const setup = !existed && context.kind !== "checkout" && projectHooks(loadConfig(), project).setup
        ? hookResult(await runHook(projectHooks(loadConfig(), project).setup, { cwd: context.path }), "setup")
        : null;
      if (mode === "fork") {
        const sourceSessionId = String(body.sourceSessionId || "");
        if (!sourceSessionId || !(await sessionBelongsToProject(sourceSessionId, project, sup))) return err(c, 404, "no_such_source_session");
        const atRecordId = typeof body.atRecordId === "string" && body.atRecordId ? body.atRecordId : null;
        const { id: sessionId } = await sup.fork(sourceSessionId, atRecordId, { cwd: context.path, name });
        bindSessionToContext(sessionId, project, context);
        hub.emit(sessionId, "session_forked", { session: { id: sessionId, contextId: context.id, branch: context.branch }, parentSessionId: sourceSessionId });
        return c.json({ id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch, forkedFrom: sourceSessionId, setup });
      }
      const { id: sessionId } = await sup.createSession({ cwd: context.path, name });
      bindSessionToContext(sessionId, project, context);
      hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch } });
      return c.json({ id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, setup });
    } catch (e) {
      const statuses = { bad_branch: 400, no_such_base_branch: 404, checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.detail ? { detail: e.detail } : {});
      if (e.code === "bad_fork_record") return err(c, 400, e.code);
      if (String(e?.message || "").startsWith("unknown")) return err(c, 404, "no_such_source_session");
      throw e;
    }
  });

  api.post("/sessions/:id/fork", async c => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const cwd = await sessionWorkspace(id, sup);
    if (!cwd) return err(c, 404, "no_such_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    const found = findProjectByWorkspace(cwd);
    const atRecordId = typeof body.atRecordId === "string" && body.atRecordId ? body.atRecordId : null;
    try {
      if (found) {
        const { project } = found;
        const context = branchContext(project, ws.currentBranch(cwd)) || projectContext(project, null);
        if (!context) return err(c, 404, "no_such_context");
        const { id: childId } = await sup.fork(id, atRecordId, { cwd: context.path, name });
        bindSessionToContext(childId, project, context);
        hub.emit(childId, "session_forked", { session: { id: childId, projectId: project.id, contextId: context.id, branch: context.branch }, parentSessionId: id });
        return c.json({ id: childId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, forkedFrom: id });
      }
      const source = await sup.meta(id);
      const { id: childId } = await sup.fork(id, atRecordId, { cwd: source?.cwd || cwd, name });
      hub.emit(childId, "session_forked", { session: { id: childId }, parentSessionId: id });
      return c.json({ id: childId, forkedFrom: id, workspacePath: source?.cwd || cwd });
    } catch (e) {
      const statuses = { bad_fork_record: 400, session_streaming: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/branch-context", async c => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const { project } = found;
    const source = await sup.meta(id);
    const currentBranch = ws.currentBranch(cwd) || null;
    let branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
    if (!branch) return err(c, 400, "bad_branch");
    try {
      branch = ws.validateBranchName(branch);
      if (branch === currentBranch) return err(c, 409, "same_branch");
      if (body.mode !== "fork" && sup.isStreaming(id)) return err(c, 409, "session_streaming");
      const existed = !!branchContext(project, branch);
      const context = await ensureBranchContext(project, branch, body.baseBranch || currentBranch || ws.MAIN_BRANCH, { syncMain: true });
      const setup = !existed && context.kind !== "checkout" && projectHooks(loadConfig(), project).setup
        ? hookResult(await runHook(projectHooks(loadConfig(), project).setup, { cwd: context.path }), "setup")
        : null;
      if (body.mode === "fork") {
        const { id: childId } = await sup.fork(id, null, { cwd: context.path, name });
        bindSessionToContext(childId, project, context);
        hub.emit(childId, "session_forked", { session: { id: childId, contextId: context.id, branch: context.branch }, parentSessionId: id });
        return c.json({ id: childId, forkedFrom: id, branch: context.branch, contextId: context.id, workspacePath: context.path, setup });
      }
      await sup.rehome(id, context.path);
      bindSessionToContext(id, project, context);
      if (hasName) await sup.setName(id, name);
      hub.emit(id, "session_meta", { branch: context.branch, workspacePath: context.path });
      return c.json({ ok: true, id, branch: context.branch, contextId: context.id, workspacePath: context.path, name: source?.name || null });
    } catch (e) {
      const statuses = { bad_branch: 400, no_such_base_branch: 404, checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409, session_streaming: 409, same_branch: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
  });

  api.get("/projects/:id/files", c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const context = requestedContext(p, c);
    if (!context) return err(c, 404, c.req.query("contextId") ? "no_such_context" : "no_such_branch");
    try {
      return c.json({
        ...readFileTree({
          workspace: context.path,
          repoPath: p.repoPath,
          target: c.req.query("target") || NO_DIFF_TARGET,
        }),
        contextId: context.id,
        branch: context.branch,
      });
    } catch (e) {
      if (e.code === "invalid_diff_target") return err(c, 400, e.code, { message: e.message });
      throw e;
    }
  });

  api.get("/projects/:id/file", c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const context = requestedContext(p, c);
    if (!context) return err(c, 404, c.req.query("contextId") ? "no_such_context" : "no_such_branch");
    try {
      return c.json({
        ...readFileView({
          workspace: context.path,
          repoPath: p.repoPath,
          path: c.req.query("path"),
          target: c.req.query("target") || NO_DIFF_TARGET,
        }),
        contextId: context.id,
        branch: context.branch,
      });
    } catch (e) {
      const statuses = {
        invalid_file_path: 400,
        file_is_directory: 400,
        file_unsupported: 400,
        file_not_found: 404,
        invalid_diff_target: 400,
        file_too_large: 413,
      };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      throw e;
    }
  });

  // ---------- session ops ----------

  const syncSession = async c => {
    const id = c.req.param("id");
    const meta = await sup.meta(id);
    if (!meta) return err(c, 404, "no_such_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    if (sup.isCompacting(id)) return err(c, 409, "session_compacting");
    try {
      const result = await sync.enroll(id);
      // The local marker is written only after the coordinator confirms the
      // remote creation. It contains no lease material or credentials.
      markSyncEnrolled(id);
      const status = await sync.status(id);
      hub.emit(id, "sync_state", { sync: status });
      return c.json({ ok: true, sessionId: id, ...status, created: result.created !== false });
    } catch (e) {
      if (syncConfig(loadConfig()).allConversations && ["sync_client_unavailable", "sync_unavailable", "sync_enrollment_failed", "sync_session_not_found"].includes(e.code)) {
        markSyncPending(id);
      }
      const statuses = {
        sync_not_configured: 409,
        sync_not_enrolled: 409,
        session_streaming: 409,
        session_compacting: 409,
        sync_stale_etag: 409,
        sync_client_unavailable: 503,
        sync_unavailable: 503,
        sync_enrollment_failed: 502,
      };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  };

  api.get("/sessions/:id/sync", async c => {
    const id = c.req.param("id");
    if (!await sup.meta(id)) return err(c, 404, "no_such_session");
    return c.json({ sessionId: id, ...(await sync.status(id)) });
  });
  api.post("/sessions/:id/sync", syncSession);
  // Keep the action name easy for non-browser clients while the UI uses the
  // noun “Synchronize”. Both routes share the same coordinator boundary.
  api.post("/sessions/:id/enroll", syncSession);

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
    try {
      const result = await mutate(id, () => sup.command(id, text.trim(), mode));
      if (result.action === "settings") return c.json({ ok: true, action: "settings" });
      return c.json({ ok: true, ...result });
    } catch (e) {
      const statuses = {
        model_required: 409, command_busy: 409, model_unavailable: 400, unknown_slash_command: 400, invalid_slash_command: 400,
        command_usage: 400, session_export_too_large: 413, github_auth_required: 401,
        github_rate_limited: 403, github_unavailable: 502,
      };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.get("/sessions/:id/export", async c => {
    const format = String(c.req.query("format") || "html").toLowerCase();
    if (format !== "html" && format !== "jsonl") return err(c, 400, "command_usage", { message: "format must be html or jsonl" });
    try {
      const output = await sup.exportSession(c.req.param("id"), format);
      return c.body(output.body, 200, {
        "content-type": output.contentType,
        "content-disposition": `attachment; filename="${output.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "no-store",
      });
    } catch (e) {
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/message", async c => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { text, mode = "prompt", images = [] } = body;
    const clientMessageId = typeof body?.clientMessageId === "string" ? body.clientMessageId.slice(0, 120) : null;
    const messageText = typeof text === "string" ? text.trim() : "";
    if (!messageText && !Array.isArray(images)) return err(c, 400, "empty_message");
    if (!messageText && images.length === 0) return err(c, 400, "empty_message");
    if (!Array.isArray(images) || images.length > 4 || images.some(image =>
      image?.type !== "image" || typeof image.data !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType || "") ||
      image.data.length > 8_000_000
    )) return err(c, 400, "invalid_images");
    let lease;
    try {
      lease = await beginStreamingMutation(id);
      await sup.message(id, messageText, mode, images, clientMessageId);
      // Real and mock supervisors call agentSettled after the asynchronous run
      // reaches idle. A synchronous/no-model failure has no active stream, so
      // finish the short mutation here instead.
      if (lease?.managed && !sup.isStreaming(id)) await finishStreamingMutation(id, lease);
      return c.json({ ok: true });
    } catch (e) {
      if (lease?.managed) await sync.release?.(id, lease).catch(() => undefined);
      if (e.code === "model_required") {
        return err(c, 409, "model_required", {
          message: "Connect a provider or choose an available model.",
        });
      }
      throw e;
    }
  });

  api.post("/sessions/:id/stop", async c => {
    const id = c.req.param("id");
    const lease = await beginStreamingMutation(id);
    try {
      await sup.stop(id);
      if (lease?.managed) await finishStreamingMutation(id, lease);
      return c.json({ ok: true });
    } catch (error) {
      if (lease?.managed) await sync.release?.(id, lease).catch(() => undefined);
      throw error;
    }
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
      compacting: sup.isCompacting(id),
      records: await sup.transcript(id),
    });
  });

  api.get("/sessions/:id/meta", async c => {
    const meta = await sup.meta(c.req.param("id"));
    return meta ? c.json(meta) : err(c, 404, "no_such_session");
  });

  api.post("/sessions/:id/model", async c => {
    const id = c.req.param("id");
    const { model } = await c.req.json();
    try {
      await mutate(id, () => sup.setModel(id, model));
      return c.json({ ok: true, model });
    } catch (e) {
      if (e.code === "model_unavailable") return err(c, 400, "model_unavailable");
      throw e;
    }
  });

  api.get("/sessions/:id/context", async c => c.json(await sup.context(c.req.param("id"))));

  api.get("/sessions/:id/thinking", async c => c.json(await sup.thinking(c.req.param("id"))));
  api.post("/sessions/:id/thinking", async c => {
    const id = c.req.param("id");
    const { level } = await c.req.json();
    return c.json(await mutate(id, () => sup.setThinking(id, level)));
  });

  api.post("/sessions/:id/name", async c => {
    const id = c.req.param("id");
    const { name } = await c.req.json();
    await mutate(id, () => sup.setName(id, name));
    return c.json({ ok: true, name: String(name || "").trim() || null });
  });

  api.post("/sessions/:id/worktree", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
    const body = await c.req.json().catch(() => ({}));
    const fork = body.fork === true;
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    const { project, worktrees } = found;
    const cfg = loadConfig();
    const localBranches = ws.listBranches(project.repoPath);
    const remoteBranches = ws.listRemoteBranches(project.repoPath);
    const remoteSource = typeof body.fromRef === "string" && body.fromRef.trim() ? body.fromRef.trim() : null;
    let branch = slug(body.branch || "");
    if (remoteSource && !remoteBranches.includes(remoteSource)) return err(c, 400, "invalid_remote_branch");
    if (!branch && remoteSource) branch = ws.localBranchForRemote(remoteSource);
    if (!branch && !fork) branch = await suggestedWorktreeBranch(project.repoPath, id, sup);
    if (!branch && remoteSource) return err(c, 400, "bad_branch");
    if (branch === ws.MAIN_BRANCH) return err(c, 409, "main_worktree_forbidden");
    const existingTarget = branch ? ws.listWorktrees(project.repoPath)[branch] || null : null;
    if (!fork && existingTarget && path.resolve(existingTarget) === path.resolve(cwd)) return c.json({ ok: true, branch, workspacePath: existingTarget, setup: null });
    if (remoteSource && branch && localBranches.includes(branch)) return err(c, 409, "branch_exists");
    if (remoteSource && fork) return err(c, 400, "invalid_fork_source");

    const parentBranch = Object.entries(worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0] || ws.currentBranch(cwd);
    if (fork) {
      const records = await sup.transcript(id);
      if (!records.length) return err(c, 400, "fork_requires_transcript");
      let branchName = branch;
      let branchWorkspace;
      try {
        ({ branch: branchName, workspacePath: branchWorkspace } = ws.forkWorkspace({
          repoPath: project.repoPath, worktreeRoot: worktreeRoot(cfg), projectId: project.id,
          parentWorkspace: cwd, parentBranch, existingBranches: localBranches, branch: branch || undefined,
        }));
      } catch (e) {
        if (e.code === "checkout_dirty") return err(c, 409, "checkout_dirty");
        if (e.code === "branch_exists") return err(c, 409, "branch_exists");
        if (e.code === "main_worktree_forbidden") return err(c, 409, e.code);
        throw e;
      }
      const setup = projectHooks(cfg, project).setup;
      const setupResult = setup ? hookResult(await runHook(setup, { cwd: branchWorkspace }), "setup") : null;
      try {
        const { id: childId } = await sup.fork(id, body.atRecordId || null, { cwd: branchWorkspace });
        hub.emit(childId, "session_forked", { session: { id: childId, branch: branchName }, parentSessionId: id });
        return c.json({ id: childId, branch: branchName, workspacePath: branchWorkspace, setup: setupResult });
      } catch (e) {
        try { ws.removeWorkspace({ repoPath: project.repoPath, workspacePath: branchWorkspace, force: true }); } catch { /* best effort cleanup */ }
        try { execFileSync("git", ["branch", "-D", branchName], { cwd: project.repoPath, stdio: "ignore" }); } catch { /* best effort cleanup */ }
        if (e.code === "bad_fork_record") return err(c, 400, "bad_fork_record");
        throw e;
      }
    }

    let target;
    try {
      target = ws.ensureWorkspace({
        repoPath: project.repoPath, worktreeRoot: worktreeRoot(cfg),
        projectId: project.id, branch, fromRef: remoteSource || "HEAD",
      });
    } catch (e) {
      if (e.code === "checkout_branch" || e.code === "main_worktree_forbidden") return err(c, 409, e.code);
      throw e;
    }
    if (path.resolve(target) === path.resolve(cwd)) return c.json({ ok: true, branch, workspacePath: target, setup: null });

    const bindings = loadBindings();
    try { await sup.rehome(id, target); }
    catch (e) { if (e.code === "session_streaming") return err(c, 409, e.code); throw e; }
    bindings[id] = { branch, workspacePath: target };
    saveBindings(bindings);
    hub.emit(id, "session_meta", { branch });
    const setup = !existingTarget && projectHooks(cfg, project).setup;
    const setupResult = setup ? hookResult(await runHook(setup, { cwd: target }), "setup") : null;
    return c.json({ ok: true, branch, workspacePath: target, setup: setupResult });
    });
  });

  api.post("/sessions/:id/switch", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
    const body = await c.req.json().catch(() => ({}));
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const { project } = found;
    const branch = slug(body.branch || "");
    const remoteSource = typeof body.fromRef === "string" && body.fromRef.trim() ? body.fromRef.trim() : null;
    const localBranches = ws.listBranches(project.repoPath);
    const remoteBranches = ws.listRemoteBranches(project.repoPath);
    if (!branch) return err(c, 400, "bad_branch");
    if (remoteSource && !remoteBranches.includes(remoteSource)) return err(c, 400, "invalid_remote_branch");
    if (branch === ws.MAIN_BRANCH) {
      if (remoteSource) return err(c, 409, "main_worktree_forbidden");
      const affected = [];
      if (ws.currentBranch(project.repoPath) !== ws.MAIN_BRANCH) {
        affected.push(...await sessionsUsingWorkspace(project, project.repoPath, sup));
      }
      if (await hasSynchronizedSibling(affected, id, sync)) return err(c, 409, "sync_shared_workspace");
      try { return c.json(await returnSessionToMain(sup, hub, id)); }
      catch (e) {
        const codes = { session_streaming: 409, no_project_for_session: 404, checkout_dirty: 409, sessions_active: 409, main_worktree_external: 409, return_rehome_failed: 409, git_switch_failed: 409 };
        if (codes[e.code]) return err(c, codes[e.code], e.code, e.detail ? { detail: e.detail, workspacePath: e.workspacePath } : e.workspacePath ? { workspacePath: e.workspacePath } : {});
        throw e;
      }
    }
    if (remoteSource && localBranches.includes(branch)) return err(c, 409, "branch_exists");
    if (!remoteSource && !localBranches.includes(branch)) return err(c, 404, "no_such_branch");
    const current = ws.currentBranch(cwd);
    if (current === branch) return c.json({ ok: true, branch, workspacePath: cwd, switched: false });
    const worktrees = ws.listWorktrees(project.repoPath);
    const target = worktrees[branch];
    if (target && path.resolve(target) !== path.resolve(cwd)) return err(c, 409, "branch_in_use", { workspacePath: target });
    const sessions = await sessionsUsingWorkspace(project, cwd, sup);
    if (await hasSynchronizedSibling(sessions, id, sync)) return err(c, 409, "sync_shared_workspace");
    if (sessions.some(session => session.streaming)) return err(c, 409, "sessions_active");
    if (ws.isDirty(cwd)) return err(c, 409, "workspace_dirty");
    try { ws.switchWorkspace({ repoPath: project.repoPath, workspacePath: cwd, branch, fromRef: remoteSource }); }
    catch (e) {
      if (e.code === "git_switch_failed" || e.code === "main_worktree_forbidden") return err(c, 409, e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
    const bindings = loadBindings();
    for (const session of sessions) bindings[session.id] = { branch, workspacePath: cwd };
    saveBindings(bindings);
    for (const session of sessions) {
      hub.emit(session.id, "session_meta", { branch });
      hub.emit(session.id, "workspace_switched", { branch, workspacePath: cwd });
    }
    return c.json({ ok: true, branch, workspacePath: cwd, switched: true });
    });
  });

  api.post("/sessions/:id/pull", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    try {
      const result = ws.pullWorkspace(cwd);
      hub.emit(id, "session_meta", { branch: ws.currentBranch(cwd) });
      return c.json({ ok: true, branch: ws.currentBranch(cwd), workspacePath: cwd, ...result });
    } catch (e) {
      if (e.code === "git_pull_failed") return err(c, 409, e.code, { detail: e.detail });
      throw e;
    }
    });
  });

  api.post("/sessions/:id/push", async c => {
    const id = c.req.param("id");
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    try {
      const result = ws.pushWorkspace(cwd);
      hub.emit(id, "session_meta", { branch: ws.currentBranch(cwd) });
      return c.json({ ok: true, branch: ws.currentBranch(cwd), workspacePath: cwd, ...result });
    } catch (e) {
      const statuses = { detached_head: 409, git_push_failed: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, { detail: e.detail });
      throw e;
    }
  });

  api.post("/sessions/:id/merge-local", async c => {
    const id = c.req.param("id");
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    const branch = ws.currentBranch(cwd);
    if (!branch || branch === ws.MAIN_BRANCH) return err(c, 400, "nothing_to_merge");
    try {
      const sourceStatus = ws.contextStatus({ repoPath: found.project.repoPath, workspacePath: cwd });
      if (sourceStatus.dirty == null) return err(c, 409, "git_status_unavailable");
      if (sourceStatus.dirty) return err(c, 409, "workspace_dirty");
      ws.prepareMain(found.project.repoPath, { fetch: true });
      const output = ws.mergeBranch(found.project.repoPath, branch);
      hub.emit(id, "git_merge", { branch, into: ws.MAIN_BRANCH });
      return c.json({ ok: true, merged: branch, into: ws.MAIN_BRANCH, stdout: output, workspacePath: found.project.repoPath });
    } catch (e) {
      const statuses = { checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409, merge_conflict: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
  });

  // Compatibility endpoint for older clients. The current UI uses merge-local,
  // whose semantics are local-only and do not clean up sessions or branches.
  api.post("/sessions/:id/merge", async c => {
    const id = c.req.param("id");
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (found) {
      const checkoutSessions = await sessionsUsingWorkspace(found.project, found.project.repoPath, sup);
      const affected = await sessionsUsingWorkspace(found.project, cwd, sup);
      if (await hasSynchronizedSibling([...checkoutSessions, ...affected], id, sync)) return err(c, 409, "sync_shared_workspace");
    }
    try { return c.json(await mergeSession(sup, hub, id)); }
    catch (e) {
      const codes = { session_streaming: 409, sessions_active: 409, merge_rehome_failed: 409, merge_cleanup_failed: 409, main_worktree_external: 409, no_project_for_session: 404, nothing_to_merge: 400, checkout_dirty: 409, merge_conflict: 409, git_switch_failed: 409 };
      if (codes[e.code]) return err(c, codes[e.code], e.code, e.detail ? { detail: e.detail, workspacePath: e.workspacePath } : e.workspacePath ? { workspacePath: e.workspacePath } : {});
      throw e;
    }
  });

  // Configured project hooks run in the current session workspace. Hook names
  // are deployment-defined; this endpoint does not invent a fixed vocabulary.
  api.post("/sessions/:id/hooks/:name", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
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
  });

  // Bang: user-initiated local shell in the session's workspace. Distinct from
  // agent tool calls end-to-end (orange ! rendering keyed on bang_* events).
  api.post("/sessions/:id/bang", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
    const { cmd } = await c.req.json();
    if (!cmd?.trim()) return err(c, 400, "empty_command");
    const cwd = (await sessionWorkspace(id, sup)) || chatsDir();
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
  });

  // Close archives the conversation only. Git contexts remain user-owned and
  // are never removed as a side effect of session lifecycle.
  api.post("/sessions/:id/close", async c => {
    const id = c.req.param("id");
    return mutate(id, async () => {
    try {
      await closeSession(sup, hub, id);
    } catch (e) {
      if (e.code === "session_streaming") return err(c, 409, "session_streaming");
      if (e.code === "main_worktree_external") return err(c, 409, e.code, { workspacePath: e.workspacePath });
      throw e;
    }
    return c.json({ ok: true });
    });
  });

  // ---------- workspace cleanup ----------
  api.delete("/projects/:id/branches/:branch", async c => {
    const p = loadConfig().projects.find(x => x.id === c.req.param("id"));
    if (!p) return err(c, 404, "no_such_project");
    const branch = decodeURIComponent(c.req.param("branch"));
    if (branch === ws.MAIN_BRANCH) return err(c, 400, "cannot_delete_main");
    const body = await c.req.json().catch(() => ({}));
    const force = body.force === true || c.req.query("force") === "1";
    const closeSessions = body.closeSessions === true;
    const context = branchContext(p, branch);
    const wsPath = context?.path || null;
    const bindings = loadBindings();
    const boundSessions = wsPath ? await sessionsUsingWorkspace(p, wsPath, sup) : [];
    for (const session of boundSessions) {
      if ((await sync.status(session.id)).synchronized) return err(c, 409, "sync_workspace_in_use");
    }
    try {
      const affected = wsPath ? await sessionsUsingWorkspace(p, wsPath, sup) : [];
      if (wsPath) {
        const branchStatus = ws.contextStatus({ repoPath: p.repoPath, workspacePath: wsPath });
        if (branchStatus.dirty == null) return err(c, 409, "git_status_unavailable");
        if (branchStatus.dirty && !force) return err(c, 409, "workspace_dirty");
        if (path.resolve(wsPath) === path.resolve(p.repoPath) && branchStatus.dirty) return err(c, 409, "checkout_dirty");
      }
      ws.prepareMain(p.repoPath, { fetch: false });
      const main = branchContext(p, ws.MAIN_BRANCH) || ws.contextStatus({ repoPath: p.repoPath, workspacePath: p.repoPath });
      for (const session of affected) {
        if (sup.isStreaming(session.id)) await sup.stop(session.id);
        if (!closeSessions) {
          await sup.rehome(session.id, main.path);
          bindings[session.id] = { projectId: p.id, workspacePath: main.path };
          hub.emit(session.id, "session_meta", { branch: ws.MAIN_BRANCH, workspacePath: main.path });
        } else {
          await sup.rehome(session.id, main.path);
          bindings[session.id] = { projectId: p.id, workspacePath: main.path };
          await closeSession(sup, hub, session.id);
        }
      }
      saveBindings(bindings);
      if (wsPath && path.resolve(wsPath) !== path.resolve(p.repoPath)) ws.removeWorkspace({ repoPath: p.repoPath, workspacePath: wsPath, force });
      ws.deleteLocalBranch(p.repoPath, branch);
      hub.emit(null, "git_branch_deleted", { projectId: p.id, branch });
      return c.json({ ok: true, branch, movedSessionIds: closeSessions ? [] : affected.map(session => session.id), closedSessionIds: closeSessions ? affected.map(session => session.id) : [] });
    } catch (e) {
      const statuses = { cannot_delete_main: 400, no_such_context: 404, no_such_branch: 404, git_status_unavailable: 409, workspace_dirty: 409, checkout_dirty: 409, main_worktree_external: 409, git_switch_failed: 409, branch_delete_failed: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
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
    if (body.sync !== undefined) {
      if (!body.sync || typeof body.sync !== "object" || Array.isArray(body.sync)) return err(c, 400, "invalid_sync_configuration", { message: "Sync configuration must be an object." });
      if (body.sync.serverUrl !== undefined && process.env.PI_WEB_SYNC_SERVER_URL !== undefined) {
        return err(c, 409, "setting_overridden", { field: "sync.serverUrl", source: "PI_WEB_SYNC_SERVER_URL" });
      }
      if (body.sync.allConversations !== undefined && process.env.PI_WEB_SYNC_ALL_CONVERSATIONS !== undefined) {
        return err(c, 409, "setting_overridden", { field: "sync.allConversations", source: "PI_WEB_SYNC_ALL_CONVERSATIONS" });
      }
      try {
        const nextSync = normalizeSyncConfig({ ...cfg.sync, ...body.sync }, { strict: true });
        sync.assertConfigurationChangeAllowed?.(syncConfig(cfg), nextSync);
        cfg.sync = nextSync;
      }
      catch (e) {
        if (e.code === "invalid_sync_configuration") return err(c, 400, e.code, { message: e.message });
        throw e;
      }
    }
    if (body.defaultModel === null) cfg.defaultModel = null;
    else if (body.defaultModel !== undefined) {
      const models = await sup.listModels();
      if (!models.some(model => model.id === body.defaultModel)) return err(c, 400, "model_unavailable");
      cfg.defaultModel = body.defaultModel;
    }
    if (body.defaultThinkingLevel !== undefined) {
      try { cfg.defaultThinkingLevel = normalizeThinkingLevel(body.defaultThinkingLevel, { strict: true }); }
      catch (e) {
        if (e.code === "invalid_thinking_level") return err(c, 400, e.code, { message: e.message });
        throw e;
      }
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
      defaultThinkingLevel: cfg.defaultThinkingLevel,
      effectiveDefaultModel: modelState.effectiveDefault,
      defaultModelStatus: modelState.status,
      modelError: modelState.error || null,
      piConfiguration,
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      repositorySources: repositorySourceState(cfg, github),
      settings: settingsState(cfg, github),
      sync: sync.state(),
    });
  });

  return api;
}
