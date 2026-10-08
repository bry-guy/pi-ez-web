import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  chatsDir, loadBindings, loadConfig, newId, normalizeHookSets, normalizeHooks, normalizePiConfig, normalizeSyncConfig, normalizeThinkingLevel, repositorySource, reposRoot, resolvePath, saveBindings, saveConfig, slug, syncConfig, worktreeRoot,
} from "./config.js";
import { chatsState, projectState, sessionWorkspace, sessionsUsingWorkspaceAsync } from "./domain.js";
import { closeSession, findProjectByWorkspace, findProjectByWorkspaceAsync, returnSessionToMain } from "./lifecycle.js";
import { hub } from "./events.js";
import * as ws from "./workspaces.js";
import { AuthFlowManager } from "./auth-flows.js";
import { GitHubClient, GitHubDeviceFlowManager, normalizeGitHubOwner } from "./github.js";
import { cloneRepository } from "./repositories.js";
import { NO_DIFF_TARGET, readFileTree, readFileView } from "./file-explorer.js";
import { hookResult, projectHooks, runHook } from "./hooks.js";
import { resolveProjectEnvironment } from "./project-environment.js";
import { gitCredentialEnvironment } from "./git-credentials.js";
import { API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID } from "./version.js";
import { createSyncCoordinator } from "./sync/coordinator.js";
import { markSyncPending } from "./sync/enrollment.js";
import { createOperationReporter, operationRequestId } from "./operations.js";
import { readLogs, logFileName } from "./logging.js";
import { assertRepositoryIdentity } from "./repository-admission.js";
import {
  err, safe, withRepositoryAdmission, formatDuration, SYNC_ERROR_STATUS,
  repositorySourceState, settingsState, suggestedWorktreeBranch, hasSynchronizedSibling,
  projectContext, projectContextAsync, requestedContext, bindSessionToContext, bindRehomedSession,
  boundProject, branchContext, branchContextAsync, primaryBranch, ensureBranchContext, sessionBelongsToProject,
} from "./routes/shared.js";
import { register as registerState } from "./routes/state.js";
import { register as registerGithub } from "./routes/github.js";
import { register as registerProviders } from "./routes/providers.js";
import { register as registerEvents } from "./routes/events.js";
import { register as registerExtensionUi } from "./routes/extension-ui.js";
import { register as registerChats } from "./routes/chats.js";
import { register as registerProjects } from "./routes/projects.js";
import { register as registerContexts } from "./routes/contexts.js";
import { register as registerFiles } from "./routes/files.js";
import { register as registerSync } from "./routes/sync.js";
import { register as registerSessions } from "./routes/sessions.js";
import { register as registerWorkspaces } from "./routes/workspaces.js";
import { register as registerHooks } from "./routes/hooks.js";
import { register as registerLifecycle } from "./routes/lifecycle.js";
import { register as registerBranches } from "./routes/branches.js";
import { register as registerSettings } from "./routes/settings.js";

export function buildApi(sup, { syncCoordinator = null, syncAdapter = null } = {}) {
  const api = new Hono();
  const sync = syncAdapter || syncCoordinator || createSyncCoordinator({ supervisor: sup, configProvider: loadConfig });
  if (syncAdapter) sup.setSyncAdapter?.(syncAdapter);
  else sup.setSyncCoordinator?.(sync);
  const guardedWorkspaceSessions = async (project, workspacePath, allowStreaming = false) => {
    const sessions = await sessionsUsingWorkspaceAsync(project, workspacePath, sup);
    if (await hasSynchronizedSibling(sessions, null, sync)) throw Object.assign(new Error("sync_workspace_in_use"), { code: "sync_workspace_in_use" });
    if (!allowStreaming && sessions.some(session => sup.isStreaming(session.id))) throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
    return sessions;
  };
  const mutate = (id, task, options = {}) => typeof sync.withMutation === "function"
    ? sync.withMutation(id, task, options)
    : task();
  const withAdmission = (id, token, task, kind = "exclusive") => syncAdapter && sup.withSyncOperation
    ? sup.withSyncOperation(id, async () => {
      await syncAdapter.assertSnapshot(id, token, await sup.sessionFile?.(id));
      return task();
    }, kind)
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
  const deps = {
    sup, sync, syncAdapter, hub, github, githubFlows, authFlows,
    mutate, withAdmission, beginStreamingMutation, finishStreamingMutation, guardedWorkspaceSessions,
    streamSSE, fs, execFile, path, ws, API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID,
    chatsDir, loadBindings, loadConfig, newId, normalizeHookSets, normalizeHooks, normalizePiConfig,
    normalizeSyncConfig, normalizeThinkingLevel, repositorySource, reposRoot, resolvePath,
    saveBindings, saveConfig, slug, syncConfig, worktreeRoot,
    chatsState, projectState, sessionWorkspace, sessionsUsingWorkspaceAsync,
    closeSession, findProjectByWorkspace, findProjectByWorkspaceAsync, returnSessionToMain,
    normalizeGitHubOwner, cloneRepository, NO_DIFF_TARGET, readFileTree, readFileView,
    hookResult, projectHooks, runHook, resolveProjectEnvironment, gitCredentialEnvironment,
    markSyncPending, createOperationReporter, operationRequestId, readLogs, logFileName, assertRepositoryIdentity,
    err, safe, withRepositoryAdmission, formatDuration, SYNC_ERROR_STATUS, repositorySourceState, settingsState,
    suggestedWorktreeBranch, hasSynchronizedSibling, projectContext, projectContextAsync, requestedContext,
    bindSessionToContext, bindRehomedSession, boundProject, branchContext, branchContextAsync,
    primaryBranch, ensureBranchContext, sessionBelongsToProject,
  };
  registerState(api, deps);
  registerGithub(api, deps);
  registerProviders(api, deps);
  registerEvents(api, deps);
  registerExtensionUi(api, deps);
  registerChats(api, deps);
  registerProjects(api, deps);
  registerContexts(api, deps);
  registerFiles(api, deps);
  registerSync(api, deps);
  registerSessions(api, deps);
  registerWorkspaces(api, deps);
  registerHooks(api, deps);
  registerLifecycle(api, deps);
  registerBranches(api, deps);
  registerSettings(api, deps);

  return api;
}
