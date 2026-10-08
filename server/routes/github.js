export function register(api, deps) {
  const { err, github, githubFlows } = deps;

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
}
