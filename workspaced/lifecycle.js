// Sleep/wake for workers. A sleeping worker is scaled to zero (its volume
// stays), so idle projects cost no memory. At most maxAwake run at once; the
// least recently used idle one sleeps to make room. idleMs optionally also
// sleeps workers after a fixed idle time. Activity = proxied requests other
// than the passive ones web makes on its own (state, events, health).
export const PASSIVE = /^\/api\/(events|state|health)$/;

export function createLifecycle({
  provider, fetchImpl = globalThis.fetch, log = console.log,
  idleMs = 0, maxAwake = 3, sweepMs = 60_000, wakeTimeoutMs = 45_000, pollMs = 500, cacheMs = 3_000, now = Date.now,
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

  // Can this worker be put to sleep right now without interrupting anything?
  async function evictable(w) {
    if (w.state !== "running" || w.pinned || inflight.get(w.name)) return false;
    const h = await health(w.name);
    if (h?.busy) { touch(w.name); return false; }
    return true;
  }

  // LRU: keep at most maxAwake workers up (pinned ones count but are never
  // chosen); put the least recently used idle ones to sleep to make room.
  async function makeRoom(keep, reserve = 0) {
    if (!maxAwake) return;
    const list = [...(await refresh())];
    const awake = list.filter(w => w.state !== "sleeping" && w.name !== keep);
    let excess = awake.length + reserve - maxAwake;
    const candidates = awake.sort((a, b) => (lastUsed.get(a.name) ?? 0) - (lastUsed.get(b.name) ?? 0));
    for (const w of candidates) {
      if (excess <= 0) break;
      if (!await evictable(w)) continue;
      await sleep(w.name, "least recently used").then(() => excess--, e => log(`workspaced: could not sleep ${w.name}: ${e.message}`));
    }
    if (excess > 0) log(`workspaced: ${excess} over the ${maxAwake}-worker limit; every awake worker is busy or pinned`);
  }

  async function doWake(name) {
    const started = now();
    await makeRoom(name, 1);
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
    if (idleMs) {
      for (const w of await refresh()) {
        if (now() - (lastUsed.get(w.name) ?? now()) < idleMs || !await evictable(w)) continue;
        await sleep(w.name, "idle").catch(e => log(`workspaced: could not sleep ${w.name}: ${e.message}`));
      }
    }
    await makeRoom(null);
  }
  const timer = (idleMs || maxAwake) && sweepMs ? setInterval(() => sweep().catch(() => {}), sweepMs) : null;
  timer?.unref?.();

  return {
    info, touch, ensureAwake, sleep, sweep, refresh, makeRoom,
    begin(name) { inflight.set(name, (inflight.get(name) || 0) + 1); touch(name); },
    end(name) { inflight.set(name, Math.max(0, (inflight.get(name) || 1) - 1)); touch(name); },
    stop() { clearInterval(timer); },
  };
}
