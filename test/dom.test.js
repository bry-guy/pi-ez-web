import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

const state = {
  apiContractVersion: 2,
  buildId: "test",
  capabilities: ["provider-auth", "github-device-auth", "repository-sources", "session-activity", "slash-commands", "project-hooks"],
  mode: "mock",
  defaultModel: "mock/fast",
  models: [
    { id: "mock/fast", provider: "mock", label: "Mock Fast" },
    { id: "mock/smart", provider: "mock", label: "Mock Smart" },
  ],
  projects: [{
    id: "p1", name: "demo", repoPath: "/tmp/demo", branch: "main",
    branches: ["main"], remoteBranches: ["origin/feature/remote-ui"], worktrees: { main: "/tmp/demo" }, occupied: {}, hooks: { check: true }, updated: "now",
    sessions: [
      { id: "s1", title: "New session", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
      { id: "sibling", title: "Sibling session", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
    ],
  }],
  chats: [],
  providers: [
    { id: "anthropic", name: "Anthropic", configured: true, sourceLabel: "OAuth", availableModels: 2, authMethods: [{ id: "oauth", label: "Anthropic OAuth" }], canLogout: true },
    { id: "openai", name: "OpenAI", configured: false, availableModels: 0, authMethods: [{ id: "api_key", label: "OpenAI API key" }], canLogout: false },
  ],
  repositorySources: { default: "local", sources: [{ id: "local", enabled: true }, { id: "github", enabled: true, configured: false, authenticated: false, owner: "bry-guy" }, { id: "git-url", enabled: true }] },
  settings: { githubOwner: { value: "bry-guy", editable: true }, defaultRepositorySource: { value: "local", editable: true } },
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
    marked,
    DOMPurify: createDOMPurify(dom.window),
    fetch: async (input, options = {}) => {
      const url = String(input);
      if (url === "/api/state") return json(state);
      if (url === "/api/models") return json({ models: state.models });
      if (url === "/api/events") return new Response(": connected v1\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url === "/api/repos") return json({ root: "/tmp", repos: [{ name: "other", path: "/tmp/other" }] });
      if (url.startsWith("/api/github/public-repos")) return json({ repos: [{ name: "pi-ez-web", fullName: "bry-guy/pi-ez-web", private: false }], nextPage: null });
      if (url === "/api/github/device-login" && options.method === "POST") return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } }, true, 202);
      if (url === "/api/github/device-login/ghf1" && !options.method) return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } });
      if (url === "/api/github/device-login/ghf1" && options.method === "DELETE") return json({ ok: true });
      if (url === "/api/sessions/s1/transcript") return json(transcript);
      if (url === "/api/sessions/s1/commands") return json({ commands: [
        { name: "settings", description: "Open settings", source: "pi" },
        { name: "model", description: "Select a model", source: "pi" },
        { name: "name", description: "Set the session display name", source: "pi" },
      ] });
      if (url === "/api/sessions/s1/command") return json({ ok: true, action: "session_meta" });
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

  store.set({ branchMenuOpen: true });
  assert.match(root.querySelector(".branch-pop")?.textContent || "", /origin\/feature\/remote-ui/);
  store.set({ branchMenuOpen: false });

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
  assert.ok(root.querySelector("[data-id='s2']"));

  root.querySelector("[data-act='repo-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  const sourceToggle = root.querySelector("[data-source-toggle]");
  assert.ok(sourceToggle);
  sourceToggle.click();
  assert.ok(root.querySelector("[data-source='github']"));
  root.querySelector("[data-source='github']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-repo-picker").textContent, /bry-guy\/pi-ez-web/);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.repoPickerOpen, false, "Escape closes the repository picker");

  root.querySelector("[data-act='repo-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  root.querySelector("[data-source-toggle]").click();
  root.querySelector("[data-source='local']").click();
  const filter = root.querySelector(".modal-filter");
  filter.focus();
  filter.value = "oth";
  filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, filter);
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.repoPickerOpen, false);

  store.state.repositorySources.sources.find(source => source.id === "github").owner = null;
  store.set({ repoPickerOpen: true, repoPickerSource: "github" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-repo-picker").textContent, /Set a GitHub owner.*or sign in/i);
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));

  store.set({ view: "settings" });
  assert.match(root.querySelector("pi-settings").textContent, /Default model/);
  assert.match(root.querySelector("pi-settings").textContent, /Anthropic/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /OpenAI API key/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /GitHub OAuth client ID/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /Agent endpoint|Streaming over SSE|Mode/);
  root.querySelector("pi-settings [data-act='save-repository-settings']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-settings").textContent, /Repository settings saved/);
  store.state.repositorySources.sources.find(source => source.id === "github").configured = true;
  root.querySelector("pi-settings [data-act='open-github-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector("pi-repo-picker").textContent, /TEST-CODE/, "Settings sign-in begins GitHub Device Flow directly");
  root.querySelector("pi-repo-picker [data-github-cancel]").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  const defaultToggle = root.querySelector("pi-settings pi-model-picker[data-mode='default'] [data-model-toggle]");
  defaultToggle.focus();
  defaultToggle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(dom.window.document.activeElement?.hasAttribute("data-model-automatic"), true, "Automatic is first in keyboard navigation");
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  store.set({ view: "chat" });

  root.querySelector(".model-chip").click();
  assert.ok(root.querySelector(".model-popover"));
  root.querySelector(".model-option[data-model='mock/smart']").click();
  assert.equal(store.state.model, "mock/smart");

  const picker = root.querySelector("pi-model-picker[data-mode='session']");
  picker.open = true;
  picker.render();
  picker.querySelector("[data-model-toggle]").getBoundingClientRect = () => ({ top: 260, bottom: 292, right: 360 });
  Object.defineProperty(dom.window, "innerHeight", { value: 300, configurable: true });
  picker.positionPopover();
  assert.ok(Number.parseInt(picker.querySelector(".model-list").style.maxHeight, 10) <= 220);
  assert.ok(Number.parseInt(picker.querySelector(".model-popover").style.maxHeight, 10) <= 276);

  const sessionRow = root.querySelector("[data-id='s1']");
  sessionRow.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(store.state.sessionId, "s1");

  const sidebar = root.querySelector("pi-sidebar");
  sidebar.querySelector("[data-act='collapse']").click();
  assert.equal(store.state.railOpen, false);
  assert.equal(sidebar.dataset.layout, "mini");
  sidebar.querySelector("[data-act='collapse']").click();
  assert.equal(store.state.railOpen, true);
  assert.equal(sidebar.dataset.layout, "rail");
  assert.equal(sidebar.querySelector("[data-act='projects']"), null, "projects has no separate navigation entry");
  assert.equal(root.querySelector("[data-screen='projects']"), null, "projects has no separate screen");
  store.set({ view: "chat" });

  applyEvent({ v: 1, seq: 101, sessionId: "sibling", type: "user_record", record: { id: "u-sibling", role: "user", text: "recent sibling" } });
  assert.equal(store.state.projects[0].sessions[0].id, "sibling");

  const composer = root.querySelector("pi-composer");
  const textarea = composer.querySelector("textarea");
  textarea.value = "/";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(composer.querySelector(".command-popover").classList.contains("hidden"), false);
  textarea.value = "/na";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(composer.querySelectorAll(".command-option").length, 1);
  assert.match(composer.querySelector(".command-option").textContent, /\/name/);
  composer.querySelector(".command-option").click();
  assert.equal(textarea.value, "/name ");

  store.state.transcripts.s1 = {
    records: [{ id: "md1", role: "assistant", text: "## A readable reply\n\nA **bold** point and `inline code`.\n\n- one\n- two", streaming: true }],
    streaming: true,
    seq: 101,
  };
  store.set({ chatId: null, projectId: "p1", sessionId: "s1", view: "chat" });
  assert.equal(root.querySelector(".markdown-content h2")?.textContent, "A readable reply");
  assert.equal(root.querySelector(".markdown-content strong")?.textContent, "bold");
  assert.equal(root.querySelectorAll(".markdown-content li").length, 2);
  applyEvent({ v: 1, seq: 102, sessionId: "s1", type: "text_delta", messageId: "md1", delta: "\n\n> Streaming stays formatted." });
  assert.match(root.querySelector(".markdown-content blockquote")?.textContent || "", /Streaming stays formatted/);

  store.state.unread = {};
  store.set({ view: "settings" });
  applyEvent({ v: 1, seq: 103, sessionId: "sibling", type: "turn_end", reason: "done" });
  assert.equal(store.state.unread.sibling, true);
  store.set({ view: "chat", projectId: "p1", sessionId: "sibling", chatId: null });
  store.markRead("sibling");
  assert.equal(store.state.unread.sibling, undefined);

  dom.window.close();
});
