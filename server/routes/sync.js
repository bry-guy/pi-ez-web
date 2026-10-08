export function register(api, deps) {
  const { loadConfig, syncConfig, hub, markSyncPending, createOperationReporter, operationRequestId, err, SYNC_ERROR_STATUS, sync, sup, syncAdapter } = deps;


  // ---------- session ops ----------

  const syncSession = async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "sync", title: "Synchronize conversation" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/sync` });
    const meta = await sup.meta(id);
    if (!meta) return err(c, 404, "no_such_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    if (sup.isCompacting(id)) return err(c, 409, "session_compacting");
    try {
      reporter.log({ type: "phase", phase: "sync-enroll", message: "Enrolling the conversation with the synchronization service." });
      const result = await sync.enroll(id, { progress: reporter.log });
      const status = await sync.status(id);
      hub.emit(id, "sync_state", { sync: status });
      const operation = reporter.finish({ httpStatus: 200, message: result.created === false ? "Conversation was already synchronized." : "Conversation synchronized successfully." });
      return c.json({ ok: true, sessionId: id, ...status, created: result.created !== false, operation });
    } catch (e) {
      if (!syncAdapter && syncConfig(loadConfig()).allConversations && ["sync_client_unavailable", "sync_unavailable", "sync_enrollment_failed", "sync_session_not_found"].includes(e.code)) {
        markSyncPending(id);
      }
      const statuses = SYNC_ERROR_STATUS;
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message: e.message || e.code });
        return err(c, statuses[e.code], e.code, { ...(e.message ? { message: e.message } : {}), operation });
      }
      if (String(e?.message || "").startsWith("unknown session")) {
        const operation = reporter.finish({ status: "error", httpStatus: 404, message: "No such session." });
        return err(c, 404, "no_such_session", { operation });
      }
      reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
      throw e;
    }
  };

  const refreshSyncSession = async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "sync-refresh", title: "Refresh synchronized conversation" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/sync/refresh` });
    const meta = await sup.meta(id);
    if (!meta) return err(c, 404, "no_such_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    if (sup.isCompacting(id)) return err(c, 409, "session_compacting");
    try {
      await (syncAdapter && sup.withSyncOperation
        ? sup.withSyncOperation(id, () => sync.refresh(id, { progress: reporter.log }))
        : sync.refresh(id, { progress: reporter.log }));
      const status = await sync.status(id);
      hub.emit(id, "sync_state", { sync: status });
      const operation = reporter.finish({ httpStatus: 200, message: "Canonical conversation refreshed." });
      return c.json({ ok: true, refreshed: true, sessionId: id, ...status, operation });
    } catch (e) {
      const statuses = SYNC_ERROR_STATUS;
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message: e.message || e.code });
        return err(c, statuses[e.code], e.code, { ...(e.message ? { message: e.message } : {}), ...(e.details ? { details: e.details } : {}), operation });
      }
      if (String(e?.message || "").startsWith("unknown session")) {
        const operation = reporter.finish({ status: "error", httpStatus: 404, message: "No such session." });
        return err(c, 404, "no_such_session", { operation });
      }
      reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
      throw e;
    }
  };

  api.get("/sessions/:id/sync", async c => {
    const id = c.req.param("id");
    if (!await sup.meta(id)) return err(c, 404, "no_such_session");
    return c.json({ sessionId: id, ...(await sync.status(id)) });
  });
  api.post("/sessions/:id/sync", syncSession);
  api.post("/sessions/:id/sync/refresh", refreshSyncSession);
  api.post("/sessions/:id/sync/check", async c => {
    if (!syncAdapter) return err(c, 409, "sync_client_unavailable");
    const id = c.req.param("id");
    if (!await sup.meta(id)) return err(c, 404, "no_such_session");
    try { return c.json(await syncAdapter.autoCheck(id)); }
    catch (error) {
      if (SYNC_ERROR_STATUS[error.code]) return err(c, SYNC_ERROR_STATUS[error.code], error.code);
      throw error;
    }
  });
  // Keep the action name easy for non-browser clients. Both routes use the
  // configured Pi sync integration.
  api.post("/sessions/:id/enroll", syncSession);
}
