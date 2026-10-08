export function register(api, deps) {
  const { err, sync, syncAdapter } = deps;


  api.post("/sessions/:id/extension-ui/:requestId", async c => {
    const adapter = syncAdapter || (typeof sync.respond === "function" ? sync : null);
    if (!adapter?.respond) return err(c, 404, "no_extension_ui");
    try {
      return c.json(adapter.respond(c.req.param("id"), c.req.param("requestId"), await c.req.json().catch(() => ({}))));
    } catch (e) {
      if (e.code === "stale_extension_ui_request") return err(c, 409, e.code, { message: e.message });
      if (e.code === "invalid_extension_ui_response") return err(c, 400, e.code, { message: e.message });
      throw e;
    }
  });

  api.delete("/sessions/:id/extension-ui/:requestId", c => {
    const adapter = syncAdapter || (typeof sync.cancel === "function" ? sync : null);
    if (!adapter?.cancel) return err(c, 404, "no_extension_ui");
    try { return c.json(adapter.cancel(c.req.param("id"), c.req.param("requestId"))); }
    catch (e) {
      if (e.code === "stale_extension_ui_request") return err(c, 409, e.code, { message: e.message });
      throw e;
    }
  });
}
