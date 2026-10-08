export function register(api, deps) {
  const { err, authFlows, sup } = deps;


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
}
