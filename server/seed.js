import { writeLog } from "./logging.js";

// Errors that clear up without operator action on this server (e.g. GitHub login).
const RETRYABLE = new Set(["github_auth_required", "github_not_configured", "github_unavailable", "github_rate_limited", "clone_in_progress"]);
const DONE = new Set(["project_exists", "repository_exists"]);

export function seedRequest(value) {
  const seed = String(value || "").trim();
  if (!seed) return null;
  const github = seed.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return github ? { source: "github", fullName: github[1] } : { source: "git-url", url: seed };
}

// Connects PI_WEB_SEED_REPOSITORY through the same API the UI uses, so a
// gateway-created workspace opens on its repository without a second step.
export function seedRepository(app, value, { retryMs = 30_000, setTimer = setTimeout } = {}) {
  const body = seedRequest(value);
  if (!body) return Promise.resolve({ status: "skipped" });
  return new Promise(resolve => {
    const attempt = async () => {
      const res = await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.setupNeeded && data.sessionId) await app.request(`/api/sessions/${encodeURIComponent(data.sessionId)}/hooks/setup`, { method: "POST" });
        writeLog("info", "Seed repository connected", { source: "seed", projectId: data.id });
        return resolve({ status: "connected", projectId: data.id });
      }
      if (DONE.has(data.error)) return resolve({ status: "exists" });
      writeLog("warn", "Seed repository not connected", { source: "seed", error: data.error || res.status });
      if (!RETRYABLE.has(data.error)) return resolve({ status: "failed", error: data.error || res.status });
      setTimer(() => attempt().catch(e => resolve({ status: "failed", error: e.message })), retryMs)?.unref?.();
    };
    attempt().catch(e => resolve({ status: "failed", error: e.message }));
  });
}
