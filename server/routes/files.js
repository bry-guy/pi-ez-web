export function register(api, deps) {
  const { path, loadConfig, NO_DIFF_TARGET, readFileTree, readFileView, err, requestedContext } = deps;


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
}
