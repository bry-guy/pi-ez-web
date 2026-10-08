export function register(api, deps) {
  const { loadConfig, normalizeHookSets, normalizePiConfig, normalizeSyncConfig, normalizeThinkingLevel, reposRoot, saveConfig, syncConfig, normalizeGitHubOwner, API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID, createOperationReporter, operationRequestId, err, repositorySourceState, settingsState, sync, github, sup, syncAdapter } = deps;


  // ---------- settings ----------
  api.post("/settings", async c => {
    const body = await c.req.json();
    const cfg = loadConfig();
    const reporter = body.pi !== undefined
      ? createOperationReporter({ id: operationRequestId(c, body), kind: "pi-profile", title: "Apply Pi resources" })
      : null;
    reporter?.log({ type: "request", phase: "request", message: "POST /api/settings (Pi resource configuration)" });
    let nextPiConfiguration;
    let syncConfigurationChanged = false;
    if (body.pi !== undefined) {
      try {
        nextPiConfiguration = normalizePiConfig(body.pi, { strict: true });
        sup.assertPiConfigurationReloadable();
      } catch (e) {
        if (e.code === "invalid_pi_configuration") {
          const operation = reporter?.finish({ status: "error", httpStatus: 400, message: e.message || e.code });
          return err(c, 400, e.code, { message: e.message, ...(operation ? { operation } : {}) });
        }
        if (e.code === "pi_configuration_busy") {
          const operation = reporter?.finish({ status: "error", httpStatus: 409, message: "An active session is still running." });
          return err(c, 409, e.code, operation ? { operation } : {});
        }
        throw e;
      }
      cfg.pi = nextPiConfiguration;
    }
    if (body.sync !== undefined) {
      if (!body.sync || typeof body.sync !== "object" || Array.isArray(body.sync)) return err(c, 400, "invalid_sync_configuration", { message: "Sync configuration must be an object." });
      if (body.sync.serverUrl !== undefined && process.env.PI_SYNC_SERVER_URL !== undefined) {
        return err(c, 409, "setting_overridden", { field: "sync.serverUrl", source: "PI_SYNC_SERVER_URL" });
      }
      if (body.sync.allConversations !== undefined && process.env.PI_WEB_SYNC_ALL_CONVERSATIONS !== undefined) {
        return err(c, 409, "setting_overridden", { field: "sync.allConversations", source: "PI_WEB_SYNC_ALL_CONVERSATIONS" });
      }
      try {
        const previousSync = syncConfig(cfg);
        const nextSync = normalizeSyncConfig({ ...cfg.sync, ...body.sync }, { strict: true });
        sync.assertConfigurationChangeAllowed?.(previousSync, nextSync);
        syncConfigurationChanged = JSON.stringify(previousSync) !== JSON.stringify(nextSync);
        if (syncConfigurationChanged) sup.assertPiConfigurationReloadable?.();
        cfg.sync = nextSync;
      }
      catch (e) {
        if (e.code === "invalid_sync_configuration") return err(c, 400, e.code, { message: e.message });
        if (e.code === "pi_configuration_busy") return err(c, 409, e.code, { message: "An active session is still running." });
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
    if (syncConfigurationChanged) syncAdapter?.resetExtensionPath?.();
    const piConfiguration = nextPiConfiguration || syncConfigurationChanged
      ? await sup.reloadPiConfiguration({ report: reporter?.log, sessionId: body.activeSessionId || null })
      : await sup.piConfigurationState();
    const modelState = await sup.modelState();
    const operation = reporter
      ? reporter.finish({
        status: piConfiguration.profile?.status === "error" ? "error" : "success",
        httpStatus: piConfiguration.profile?.status === "error" ? 502 : 200,
        message: piConfiguration.profile?.status === "error"
          ? `Pi profile could not be loaded: ${piConfiguration.profile.error || "unknown profile error"}`
          : body.activeSessionId
            ? "Pi profile applied and the selected session runtime was reloaded."
            : "Pi profile applied; the new configuration is ready for the next session runtime.",
      })
      : null;
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
      ...(operation ? { operation } : {}),
    });
  });
}
