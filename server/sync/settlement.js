export function settleSync(coordinator, sessionId) {
  let result;
  try { result = coordinator?.agentSettled?.(sessionId); }
  catch (error) {
    console.warn("pi-ez-web sync settlement failed", { sessionId, code: error?.code || "sync_unavailable" });
    return;
  }
  Promise.resolve(result).catch(error => {
    // Settlement runs after the HTTP response and must not become an
    // unhandled rejection. The coordinator emits the public sync_state error.
    console.warn("pi-ez-web sync settlement failed", { sessionId, code: error?.code || "sync_unavailable" });
  });
}
