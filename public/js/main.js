import "./shell.js";
import "./thread.js";
import "./panels.js";
import { connectSSE, openTranscript, refreshState, resumeConnection } from "./api.js";
import { store } from "./store.js";
import { restoreLastSelection, selectChat, selectSession } from "./shell.js";

let updateReloadRequested = false;

async function loadUiConfig() {
  try {
    const response = await fetch("/ui-config.json", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (config && typeof config === "object" && !Array.isArray(config)) store.set({ uiConfig: config });
  } catch {
    // The UI remains compatible with deployments that predate this endpoint.
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const announceUpdate = worker => {
      if (navigator.serviceWorker.controller && worker) store.set({ updateAvailable: true });
    };
    if (registration.waiting) announceUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") announceUpdate(worker);
      });
    });
    window.__piApplyUpdate = () => {
      updateReloadRequested = true;
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
      if (!registration.waiting) location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateReloadRequested) location.reload();
    });
  } catch {
    // The app remains fully usable when service workers are unavailable.
  }
}

window.addEventListener("offline", () => store.set({ offline: true, reconnecting: false }));
window.addEventListener("online", resumeConnection);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resumeConnection(); });
window.addEventListener("pageshow", resumeConnection);
await loadUiConfig();
void registerServiceWorker();
connectSSE();
try {
  await refreshState();
} catch {
  // PiApp renders the fatal restart prompt from store.state.fatalError.
}

// Restore the last selected session; fall back to the most recent chat, then a project session.
const s = store.state;
if (!s.fatalError && !restoreLastSelection() && s.chats[0]) selectChat(s.chats[0].id);
else if (!s.fatalError && !store.activeKey()) {
  const p = s.projects[0];
  if (p?.sessions[0]) { store.state.openTree[p.id] = true; selectSession(p.id, p.sessions[0].id); }
  else store.notify("state");
}
