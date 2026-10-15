// Sleep/wake for workers. A sleeping worker is scaled to zero (its volume
// stays), so idle projects cost no memory. Activity = proxied requests other
// than the passive ones web makes on its own (state, events, health).
export const PASSIVE = /^\/api\/(events|state|health)$/;

export function createLifecycle({
  provider, fetchImpl = globalThis.fetch, log = console.log,
  idleMs = 20 * 60_000, sweepMs = 60_000, wakeTimeoutMs = 45_000, pollMs = 500, cacheMs = 3_000, now = Date.now,
}) {
  const lastUsed = new Map();
  const inflight = new Map();
  const waking = new Map();
  let cache = { at: -Infinity, byName: new Map() };

  async function refresh() {
    const list = await provider.list();
    cache = { at: now(), byName: new Map(list.map(w => [w.name, w])) };
    for (const w of list) if (!lastUsed.has(w.name)) lastUsed.set(w.name, now());
    return list;
  }
  async function info(name) {
    if (now() - cache.at > cacheMs) await refresh();
    return cache.byName.get(name) || null;
  }
  const touch = name => lastUsed.set(name, now());

  async function health(name) {
    const base = provider.upstream(name);
    if (!base) return null;
    try {
      const res = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function doWake(name) {
    const started = now();
    await provider.scale(name, 1);
    const deadline = started + wakeTimeoutMs;
    while (now() < deadline) {
      if (await health(name)) {
        log(`workspaced: woke ${name} in ${now() - started}ms`);
        cache.at = -Infinity;
        touch(name);
        return true;
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    return false;
  }

  // Resolves true once the worker answers; false if it is still starting.
  async function ensureAwake(name) {
    const w = await info(name);
    if (w?.state !== "sleeping" && w?.state !== "starting") return true;
    if (!waking.has(name)) waking.set(name, doWake(name).finally(() => waking.delete(name)));
    return waking.get(name);
  }

  async function sleep(name, reason) {
    await provider.scale(name, 0);
    cache.at = -Infinity;
    log(`workspaced: slept ${name} (${reason})`);
  }

  // Busy = a request in flight (hooks, setup, bang commands) or the worker
  // reporting an agent turn; background processes the agent left don't count.
  async function sweep() {
    if (!idleMs) return;
    for (const w of await refresh()) {
      if (w.state !== "running" || w.pinned || inflight.get(w.name)) continue;
      if (now() - (lastUsed.get(w.name) ?? now()) < idleMs) continue;
      const h = await health(w.name);
      if (h?.busy) { touch(w.name); continue; }
      await sleep(w.name, "idle").catch(e => log(`workspaced: could not sleep ${w.name}: ${e.message}`));
    }
  }
  const timer = idleMs && sweepMs ? setInterval(() => sweep().catch(() => {}), sweepMs) : null;
  timer?.unref?.();

  return {
    info, touch, ensureAwake, sleep, sweep, refresh,
    begin(name) { inflight.set(name, (inflight.get(name) || 0) + 1); touch(name); },
    end(name) { inflight.set(name, Math.max(0, (inflight.get(name) || 1) - 1)); touch(name); },
    stop() { clearInterval(timer); },
  };
}
