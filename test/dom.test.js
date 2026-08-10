import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const state = {
  mode: "mock",
  defaultModel: "mock/fast",
  models: [
    { id: "mock/fast", provider: "mock", label: "Mock Fast" },
    { id: "mock/smart", provider: "mock", label: "Mock Smart" },
  ],
  projects: [{
    id: "p1", name: "demo", repoPath: "/tmp/demo", branch: "main",
    branches: ["main"], worktrees: { main: "/tmp/demo" }, occupied: {}, updated: "now",
    sessions: [
      { id: "s1", title: "New session", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
      { id: "sibling", title: "Sibling session", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
    ],
  }],
  chats: [],
};
const transcript = { sessionId: "s1", seq: 0, streaming: false, records: [] };

function json(data, ok = true, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function boot() {
  const dom = new JSDOM("<!doctype html><html><body><pi-app></pi-app></body></html>", {
    url: "http://pi-web.test/",
    pretendToBeVisual: true,
  });
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    const timer = realSetInterval(fn, ms, ...args);
    timer.unref?.();
    return timer;
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    EventSource: class { close() {} },
    fetch: async (input, options = {}) => {
      const url = String(input);
      if (url === "/api/state") return json(state);
      if (url === "/api/models") return json({ models: state.models });
      if (url === "/api/events") return new Response(": connected v1\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url === "/api/repos") return json({ root: "/tmp", repos: [{ name: "other", path: "/tmp/other" }] });
      if (url === "/api/sessions/s1/transcript") return json(transcript);
      if (url === "/api/settings" || url === "/api/sessions/s1/model") return json({ ok: true });
      if (url === "/api/chats") return json({ id: "c1" });
      if (url.includes("/api/projects/") && url.endsWith("/sessions")) return json({ id: "s2", projectId: "p1" });
      if (url === "/api/projects") return json({ id: "p2", sessionId: "s2" });
      if (url.includes("/api/projects/") && url.endsWith("/files")) return json({ tree: [] });
      return json({ ok: true });
    },
  });

  await import(`../public/js/main.js?dom-test=${Date.now()}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  return dom;
}

test("DOM gate: actions, focus, models, and keyboard paths work", async () => {
  const dom = await boot();
  const { store } = await import("../public/js/store.js");
  const { applyEvent } = await import("../public/js/api.js");
  const root = dom.window.document.querySelector("pi-app");
  assert.ok(root.querySelector("pi-sidebar"));
  assert.match(root.querySelector(".model-chip").textContent, /Mock Fast/);

  store.state.transcripts.sibling = { records: [], streaming: true, seq: -1 };
  store.notify("transcript");
  const send = root.querySelector(".send-btn");
  assert.equal(send.disabled, true);
  assert.match(root.querySelector(".composer-hint").textContent, /branch busy — Sibling session is taking a turn/);
  assert.equal(root.querySelector("[data-id='sibling']").classList.contains("streaming"), true);
  store.set({ branchMenuOpen: true });          // user had the menu open
  store.state.transcripts.sibling.streaming = true;
  store.notify("transcript");
  assert.equal(store.state.branchMenuOpen, false);
  assert.equal(root.querySelector(".branch-pop"), null);
  store.state.transcripts.sibling.streaming = false;
  store.notify("transcript");
  assert.equal(root.querySelector(".branch-pop"), null); // does not reappear

  store.state.transcripts.s1 ||= { records: [], streaming: false, seq: -1 };
  store.state.transcripts.s1.streaming = true;
  store.notify("transcript");
  applyEvent({ v: 1, seq: 99, sessionId: "s1", type: "queue_update", followUp: 1 });
  assert.match(root.querySelector(".composer-hint").textContent, /1 follow-up queued/);
  applyEvent({ v: 1, seq: 100, sessionId: "s1", type: "turn_end", reason: "done" });
  assert.equal(store.state.queued.s1, undefined);
  assert.equal(send.disabled, false);
  assert.equal(root.querySelector("[data-id='sibling']").classList.contains("streaming"), false);

  const search = root.querySelector(".rail-search");
  search.focus();
  search.value = "d";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, search);

  const newChat = root.querySelector(".chats-head [data-act='new-chat']");
  assert.ok(newChat);
  newChat.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.chatId, "c1");

  const projectPlus = root.querySelector("[data-act='new-project-session']");
  assert.ok(projectPlus);
  projectPlus.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.sessionId, "s2");

  root.querySelector("[data-act='repo-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  const filter = root.querySelector(".modal-filter");
  filter.focus();
  filter.value = "oth";
  filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, filter);
  root.querySelector("pi-repo-picker [data-act='close']").click();
  assert.equal(store.state.repoPickerOpen, false);

  root.querySelector(".model-chip").click();
  assert.ok(root.querySelector(".model-popover"));
  root.querySelector(".model-option[data-model='mock/smart']").click();
  assert.equal(store.state.model, "mock/smart");

  const sessionRow = root.querySelector("[data-act='session-row']");
  sessionRow.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(store.state.sessionId, "s1");

  dom.window.close();
});
