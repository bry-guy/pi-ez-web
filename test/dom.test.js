import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

const state = {
  apiContractVersion: 5,
  buildId: "test",
  capabilities: ["provider-auth", "github-device-auth", "repository-sources", "session-activity", "slash-commands", "project-hooks", "workspace-actions", "workspace-contexts", "workspace-branches", "pi-resources", "extension-activity", "subagent-activity", "file-explorer"],
  mode: "mock",
  defaultModel: "mock/fast",
  defaultThinkingLevel: "xhigh",
  models: [
    { id: "mock/fast", provider: "mock", label: "Mock Fast" },
    { id: "mock/smart", provider: "mock", label: "Mock Smart" },
  ],
  projects: [{
    id: "p1", name: "demo", repoPath: "/tmp/demo", branch: "main",
    branches: ["main", "develop", "feature/alpha", "feature/beta", "feature/gamma", "feature/delta", "feature/epsilon"], remoteBranches: ["origin/feature/remote-ui"], worktrees: { main: "/tmp/demo" },
    contexts: [
      { id: "ctx-main", branch: "main", path: "/tmp/demo", kind: "checkout", dirty: false, status: "clean", ahead: 0, behind: 0, sessions: [
        { id: "s1", title: "New session", when: "now", streaming: false },
        { id: "sibling", title: "Sibling session", when: "now", streaming: false },
      ] },
      { id: "ctx-feature", branch: "feature/viewer", path: "/tmp/demo-feature", kind: "worktree", dirty: true, status: "dirty", ahead: 0, behind: 0, sessions: [] },
    ],
    workspaceStatus: { main: { id: "ctx-main", branch: "main", path: "/tmp/demo", kind: "checkout", dirty: false, status: "clean", ahead: 0, behind: 0, sessions: [], externalMain: false, protected: false } }, hooks: { check: true }, updated: "now",
    sessions: [
      { id: "s1", title: "New session", contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
      { id: "sibling", title: "Sibling session", contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
    ],
  }],
  chats: [],
  sync: { version: 1, configured: true, enabled: true, connection: "available", implementation: "fake", error: null },
  providers: [
    { id: "anthropic", name: "Anthropic", configured: true, sourceLabel: "OAuth", availableModels: 2, authMethods: [{ id: "oauth", label: "Anthropic OAuth" }], canLogout: true },
    { id: "openai", name: "OpenAI", configured: false, availableModels: 0, authMethods: [{ id: "api_key", label: "OpenAI API key" }], canLogout: false },
  ],
  repositorySources: { default: "local", sources: [{ id: "local", enabled: true }, { id: "github", enabled: true, configured: false, authenticated: false, owner: "bry-guy" }, { id: "git-url", enabled: true }] },
  settings: { githubOwner: { value: "bry-guy", editable: true }, defaultRepositorySource: { value: "local", editable: true } },
  piConfiguration: {
    config: { profile: "https://github.com/bry-guy/dotfiles", packages: ["npm:context-mode"], extensions: [] },
    profile: { status: "loaded", source: "https://github.com/bry-guy/dotfiles", error: null },
    warnings: [],
    runtime: { extensions: [{ path: "context-mode" }], errors: [], skills: [{ name: "todo-discipline", path: "/tmp/todo/SKILL.md" }], prompts: 0 },
  },
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
  let narrowViewport = false;
  dom.setNarrowViewport = value => { narrowViewport = value; };
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
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    matchMedia: () => ({ matches: narrowViewport, addEventListener() {}, removeEventListener() {} }),
    EventSource: class { close() {} },
    marked,
    DOMPurify: createDOMPurify(dom.window),
    fetch: async (input, options = {}) => {
      const url = String(input);
      if (url === "/api/state") return json(state);
      if (url === "/api/models") return json({ models: state.models });
      if (url.startsWith("/api/logs")) return json({ file: "logs/pi-ez-web.log", logs: [{ at: Date.now(), level: "info", source: "operation", message: "Server is ready." }] });
      if (url === "/api/events") return new Response(": connected v1\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url === "/api/repos") return json({ root: "/tmp", repos: [{ name: "other", path: "/tmp/other" }] });
      if (url.startsWith("/api/github/public-repos")) return json({ repos: [{ name: "pi-ez-web", fullName: "bry-guy/pi-ez-web", private: false }], nextPage: null });
      if (url === "/api/github/device-login" && options.method === "POST") return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } }, true, 202);
      if (url === "/api/github/device-login/ghf1" && !options.method) return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } });
      if (url === "/api/github/device-login/ghf1" && options.method === "DELETE") return json({ ok: true });
      if (url === "/api/sessions/s1/transcript") return json(transcript);
      if (url === "/api/sessions/s1/push-preview") return json({ ok: true, branch: "main", upstream: "origin/main", head: "head-2", baseHead: "head-1", commitCount: 2, commits: [{ hash: "head-2", shortHash: "head-2", subject: "second commit" }, { hash: "head-1", shortHash: "head-1", subject: "first commit" }] });
      if (url === "/api/sessions/s1/push" && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-push";
        return json({ ok: true, branch: "main", upstream: "origin/main", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Pushed main to origin/main." }] } });
      }
      if (url === "/api/sessions/s1/merge-local" && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-merge";
        if (dom.window.__holdMerge) return new Promise(resolve => { dom.window.__resolveMerge = () => resolve(dom.window.__mergeFails ? json({ error: "http_502" }, false, 502) : json({ ok: true, merged: "feat/ship", into: "main", deleted: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Merged feat/ship into main." }] } })); });
        return json({ ok: true, merged: "feat/ship", into: "main", deleted: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Merged feat/ship into main." }] } });
      }
      if (url === "/api/sessions/s1/sync" && options.method === "POST") {
        state.projects[0].sessions[0].synchronized = true;
        state.projects[0].sessions[0].syncState = "available";
        state.projects[0].contexts[0].sessions[0].synchronized = true;
        state.projects[0].contexts[0].sessions[0].syncState = "available";
        const operationId = options.headers?.["x-pi-operation-id"] || options.headers?.get?.("x-pi-operation-id") || "test-op";
        return json({ ok: true, sessionId: "s1", created: true, synchronized: true, syncState: "available", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Conversation synchronized successfully." }] } });
      }
      if (url === "/api/sessions/s1/sync/refresh" && options.method === "POST") {
        dom.window.__refreshCalls = (dom.window.__refreshCalls || 0) + 1;
        const operationId = options.headers?.["x-pi-operation-id"] || options.headers?.get?.("x-pi-operation-id") || "test-refresh";
        return json({ ok: true, refreshed: true, sessionId: "s1", synchronized: true, syncState: "available", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Canonical conversation refreshed." }] } });
      }
      if (url.includes("/api/sessions/") && url.endsWith("/close") && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-close";
        return json({ ok: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Session closed." }] } });
      }
      if (url === "/api/sessions/s1/commands") return json({ commands: [
        { name: "settings", description: "Open settings", source: "pi" },
        { name: "model", description: "Select a model", source: "pi" },
        { name: "name", description: "Set the session display name", source: "pi" },
      ] });
      if (url === "/api/sessions/s1/command") return json({ ok: true, action: "session_meta" });
      if (url === "/api/sessions/s1/branch-context" && options.method === "POST") {
        const project = state.projects[0];
        const session = project.sessions.find(item => item.id === "s1");
        Object.assign(session, { branch: "develop", contextId: "ctx-develop", workspacePath: "/tmp/demo-develop" });
        project.contexts.find(context => context.id === "ctx-main").sessions = project.contexts.find(context => context.id === "ctx-main").sessions.filter(item => item.id !== "s1");
        project.contexts.push({ id: "ctx-develop", branch: "develop", path: "/tmp/demo-develop", kind: "worktree", dirty: false, status: "clean", ahead: 0, behind: 0, sessions: [session] });
        const operationId = options.headers?.["x-pi-operation-id"] || "test-switch";
        return json({ ok: true, id: "s1", branch: "develop", contextId: "ctx-develop", workspacePath: "/tmp/demo-develop", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Switched session s1 to develop." }] } });
      }
      if (url.endsWith("/hooks/setup") && options.method === "POST") {
        dom.window.__setupStarted = true;
        const operationId = options.headers?.["x-pi-operation-id"] || "test-setup";
        if (dom.window.__holdSetup) return new Promise(resolve => { dom.window.__resolveSetup = () => resolve(dom.window.__setupFails ? json({ error: "http_502" }, false, 502) : json({ hook: "setup", ok: true, exit: 0, stdout: "setup ok\n", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "Setup complete." }] } })); });
        return json({ hook: "setup", ok: true, exit: 0, stdout: "setup ok\n", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "Setup complete." }] } });
      }
      if (url.endsWith("/hooks/check") && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-check";
        return json({ hook: "check", ok: true, exit: 0, command: "npm test", stdout: "check ok\n", stderr: "", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "check ok" }] } });
      }
      if (url === "/api/settings" || url === "/api/sessions/s1/model") return json({ ok: true });
      if (url === "/api/chats") return json({ id: "c1" });
      if (url.includes("/api/projects/") && url.endsWith("/sessions")) {
        state.projects[0].sessions.unshift({ id: "s2", title: "Chat Name", branch: "feature/from-picker", contextId: "ctx-feature", workspacePath: "/tmp/demo-feature", model: "mock/fast", when: "now", streaming: false, children: [] });
        return json({ id: "s2", projectId: "p1", branch: "feature/from-picker", contextId: "ctx-feature", workspacePath: "/tmp/demo-feature", setupNeeded: true, operation: { id: options.headers?.["x-pi-operation-id"] || "test-create", status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Created session s2 on feature/from-picker." }] } });
      }
      if (url === "/api/projects") return json({ id: "p2", sessionId: "s2", setupNeeded: true });
      if (url.includes("/api/projects/") && url.includes("/file?")) {
        const params = new URL(url, "http://pi-web.test").searchParams;
        const target = params.get("target") || "none";
        const targets = ["none", "HEAD", "main"];
        return json({
          path: "src/app.js", size: 18, binary: false, content: "const answer = 42;\n",
          highlighted: '<span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>;\n',
          language: "javascript", target, targets,
          diff: target === "none" ? null : { target, targets, adds: target === "main" ? 2 : 1, dels: 0, changed: true, binary: false,
            lines: [{ sign: "", hunk: true, text: "@@ -1 +1,2 @@" }, { sign: "+", text: "const answer = 42;" }] },
        });
      }
      if (url.includes("/api/projects/") && (url.endsWith("/files") || url.includes("/files?"))) {
        const target = new URL(url, "http://pi-web.test").searchParams.get("target") || "none";
        const targets = ["none", "HEAD", "main"];
        const tree = target === "none" ? [
          { n: "src", p: "src", s: "modified", c: [{ n: "app.js", p: "src/app.js", s: "modified" }] },
          { n: "README.md", p: "README.md" },
          { n: "new.js", p: "new.js", s: "new" },
        ] : [
          { n: "src", p: "src", s: "modified", c: [{ n: "app.js", p: "src/app.js", s: "modified" }, { n: "untouched.js", p: "src/untouched.js" }] },
          { n: "new.js", p: "new.js", s: "new" },
          { n: "old.js", p: "old.js", s: "removed" },
          { n: "README.md", p: "README.md" },
        ];
        return json({ target, targets, tree });
      }
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
  const { openSessionPicker, selectSession } = await import("../public/js/shell.js");
  const root = dom.window.document.querySelector("pi-app");
  assert.ok(root.querySelector("pi-sidebar"));
  assert.match(root.querySelector(".model-chip").textContent, /Mock Fast/);
  const project = store.state.projects[0];
  const session = project.sessions.find(item => item.id === "s1");
  const originalSession = { ...session };
  project.contexts.push({ id: "ctx-missing", branch: null, path: "/tmp/missing", kind: "unavailable", dirty: null, status: "unavailable", sessions: [session] });
  Object.assign(session, { contextId: "ctx-missing", branch: null, workspacePath: "/tmp/missing" });
  openSessionPicker("p1", { mode: "switch", sourceSessionId: "s1" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']").disabled, false, "a missing context can switch to main");
  root.querySelector("[data-act='close-session-picker']").click();
  Object.assign(session, originalSession);
  project.contexts.pop();
  store.notify("state");

  store.state.transcripts.sibling = { records: [], streaming: true, seq: -1 };
  store.notify("transcript");
  const send = root.querySelector(".send-btn");
  assert.equal(send.disabled, false);
  assert.doesNotMatch(root.querySelector(".composer textarea").placeholder, /Another session/);
  assert.equal(root.querySelector("[data-id='sibling']").classList.contains("streaming"), true);
  assert.equal(root.querySelector("pi-header [data-act='settings']"), null);
  root.querySelector("pi-sidebar [data-act='settings']").click();
  assert.equal(store.state.view, "settings");
  assert.ok(root.querySelector("pi-settings"));
  store.set({ view: "chat" });
  root.querySelector("pi-header [data-act='workspace-settings']").click();
  assert.ok(root.querySelector(".session-picker"));
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']").disabled, true);
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='fork']").disabled, true);
  assert.equal(root.querySelector("[data-act='merge-branch']").disabled, true);
  assert.equal(root.querySelector("[data-act='delete-branch']").disabled, true);
  assert.equal(root.querySelector("[data-session-name]").value, "New session");
  assert.match(root.querySelector(".session-picker-actions").textContent, /Session/);
  assert.ok([...root.querySelectorAll(".session-context-heading")].some(node => node.textContent.includes("Workspace")));
  assert.ok([...root.querySelectorAll(".session-context-heading")].some(node => node.textContent.includes("Git")));
  assert.equal(root.querySelector("pi-header [data-act='sync-session']"), null, "Sync is no longer a header action");
  assert.equal(root.querySelector(".session-picker [data-act='sync-session']").textContent, "sync");
  root.querySelector(".session-picker [data-act='sync-session']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".operation-modal"), null, "operations no longer open a terminal modal");
  assert.match(root.querySelector("[data-operation-hint='sync']").textContent, /Conversation synchronized/);
  assert.equal(root.querySelector(".session-picker [data-act='sync-session']"), null, "Enrolled sessions do not offer sync again");
  const feedNow = Date.now() + 1000;
  store.state.operations.unshift({ id: "feed-test", kind: "sync", title: "Synchronize this conversation", sessionId: "s1", status: "success", startedAt: feedNow - 2, events: [{ at: feedNow - 1, type: "phase", message: "Older sync event" }, { at: feedNow, type: "result", message: "Latest sync event" }] });
  store.notify("state");
  let feedEvents = [...root.querySelectorAll(".session-operation-feed .session-operation-event")];
  assert.ok(feedEvents.length >= 2);
  assert.equal(feedEvents.at(-1).textContent, "Latest sync event");
  root.querySelector("[data-act='close-session-picker']").click();
  assert.equal(root.querySelector("pi-header [data-act='refresh-sync']").textContent, "Refresh");
  root.querySelector("pi-header [data-act='refresh-sync']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.__refreshCalls, 1);
  selectSession("p1", "sibling");
  await new Promise(resolve => setTimeout(resolve, 20));
  selectSession("p1", "s1");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.__refreshCalls, 2);
  root.querySelector("pi-header [data-act='workspace-settings']").click();
  feedEvents = [...root.querySelectorAll(".session-operation-feed .session-operation-event")];
  assert.equal(feedEvents.at(-1).textContent, "Latest sync event", "picker logs survive close and reopen");
  assert.equal(root.querySelector("[data-act='run-hook']").textContent, "Check");
  assert.doesNotMatch(root.querySelector(".session-picker").textContent, /Run check/);
  assert.ok(root.querySelector("[data-act='push-branch']"));
  root.querySelector("[data-act='push-branch']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector(".confirm-modal").textContent, /second commit/);
  assert.match(root.querySelector(".confirm-modal").textContent, /first commit/);
  const confirmActions = root.querySelector(".confirm-actions");
  assert.equal(confirmActions.querySelector(":scope > .confirm-button-row .confirm-back").textContent, "Go back");
  assert.equal(confirmActions.querySelector(":scope > .confirm-button-row .confirm-cta").textContent, "Push commits");
  assert.equal(confirmActions.querySelector(":scope > .confirm-progress"), null);
  root.querySelector(".confirm-modal [data-act='go']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".confirm-modal"), null);
  root.querySelector("pi-header [data-act='workspace-settings']").click();
  root.querySelector("[data-act='run-hook']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".operation-modal"), null, "hook output stays out of a terminal modal");
  assert.match(root.querySelector("[data-operation-hint='hook']").textContent, /check ok/);
  root.querySelector("[data-act='toggle-branch-menu']").click();
  assert.equal(root.querySelectorAll(".branch-picker-scroll .branch-option").length, 8);
  assert.deepEqual([...root.querySelectorAll(".branch-picker-scroll .branch-option")].map(button => button.dataset.branch), [
    "main", "develop", "feature/alpha", "feature/beta", "feature/delta", "feature/epsilon", "feature/gamma", "feature/viewer",
  ]);
  assert.equal(root.querySelector(".branch-picker-pinned"), null);
  assert.ok(root.querySelector("[data-act='select-session-branch'][data-branch='__new__']"));
  root.querySelector("[data-act='select-session-branch'][data-branch='develop']").click();
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']").disabled, false);
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='fork']").disabled, false);
  root.querySelector("[data-act='apply-session-branch'][data-mode='switch']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.findSession("s1", store.state.projects[0].sessions).branch, "develop");
  assert.match(root.querySelector("pi-header .workspace-branch").textContent, /develop/);
  assert.match(store.state.operations.find(operation => operation.kind === "switch-session").events.at(-1).message, /Switched session s1 to develop/);
  store.state.transcripts.sibling.streaming = false;
  store.notify("transcript");

  store.state.openTree.p1 = false;
  store.notify("state");
  root.querySelector("[data-act='project-row']").click();
  assert.equal(store.state.sessionId, "s1");
  assert.equal(store.state.openTree.p1, false);
  root.querySelector("[data-act='toggle-tree'][data-tree-id='p1']").click();
  assert.equal(store.state.openTree.p1, true);
  root.querySelector("[data-act='session-row'][data-id='sibling']").click();
  assert.equal(store.state.sessionId, "sibling");

  store.state.transcripts.s1 ||= { records: [], streaming: false, seq: -1 };
  store.state.transcripts.s1.streaming = true;
  store.notify("transcript");
  applyEvent({ v: 1, seq: 99, sessionId: "s1", type: "queue_update", followUp: 1 });
  assert.doesNotMatch(root.querySelector(".composer textarea").placeholder, /steering message/);
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
  assert.ok(root.querySelector(".session-picker"));
  assert.equal(root.querySelectorAll(".session-history-row").length, 2);
  assert.match(root.querySelector(".session-history").textContent, /History/);
  assert.match(root.querySelector(".branch-picker-trigger").textContent, /main/);
  const newSessionName = root.querySelector("[data-session-name]");
  newSessionName.value = "Chat Name";
  newSessionName.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.match(root.querySelector(".branch-picker-trigger").textContent, /main/, "naming a session keeps the visible branch selection");
  root.querySelector("[data-act='toggle-branch-menu']").click();
  root.querySelector("[data-act='select-session-branch'][data-branch='__new__']").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const newBranchInput = root.querySelector("[data-session-new-branch]");
  assert.equal(dom.window.document.activeElement, newBranchInput);
  assert.equal(newBranchInput.value, "feature/chat-name");
  newBranchInput.value = "feature/from-picker";
  newBranchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, newBranchInput);
  assert.equal(root.querySelector("[data-act='create-session-context']").disabled, false);
  dom.window.__holdSetup = true;
  root.querySelector("[data-act='create-session-context']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.sessionId, "s2");
  assert.ok(root.querySelector("[data-id='s2']"));
  assert.equal(dom.window.__setupStarted, true, "setup starts after the returned session is selected");
  assert.equal(root.querySelector(".send-btn").disabled, false, "composer remains usable during setup");
  assert.ok(root.querySelector(".bar-operation-hint .operation-dot"), "background setup appears in the title hint");
  assert.equal(root.querySelector(".operation-row-hint"), null, "sidebar operation hints are removed");
  assert.equal(root.querySelector(".operation-modal"), null, "session creation stays non-blocking");
  root.querySelector("pi-header [data-act='workspace-settings']").click();
  assert.equal(root.querySelector(".bar-operation-hint"), null, "opening the picker removes the title hint space");
  assert.ok(root.querySelector(".session-operation-feed"));
  root.querySelector("[data-act='close-session-picker']").click();
  openSessionPicker("p1", { mode: "switch", sourceSessionId: "s1" });
  dom.window.__setupFails = true;
  dom.window.__resolveSetup();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.sessionPicker.sourceSessionId, "s1", "a background setup failure leaves a newer picker open");
  assert.equal(store.state.sessionPickerError, null, "a background setup failure does not leak into another picker");
  assert.match(store.state.error, /http_502|Setup failed/);
  root.querySelector("[data-act='close-session-picker']").click();
  store.set({ error: null });
  dom.window.__holdSetup = false;
  dom.window.__setupFails = false;

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
  root.querySelector("pi-repo-picker [data-repo='/tmp/other']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.repoPickerOpen, false, "project picker closes before background setup");
  assert.equal(store.state.operations.find(operation => operation.kind === "create-project")?.status, "success");

  store.state.repositorySources.sources.find(source => source.id === "github").owner = null;
  store.set({ repoPickerOpen: true, repoPickerSource: "github" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-repo-picker").textContent, /Set a GitHub owner.*or sign in/i);
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));

  store.set({ view: "settings" });
  assert.match(root.querySelector("pi-settings").textContent, /Default model/);
  assert.match(root.querySelector("pi-settings").textContent, /Default thinking mode/);
  assert.equal(root.querySelector("pi-settings [data-setting='defaultThinkingLevel']").value, "xhigh");
  assert.match(root.querySelector("pi-settings").textContent, /todo-discipline/);
  assert.match(root.querySelector("pi-settings").textContent, /Anthropic/);
  assert.match(root.querySelector("pi-settings").textContent, /Pi profile & extensions/);
  assert.equal(root.querySelectorAll("pi-settings .pi-loaded-list").length, 2);
  assert.match(root.querySelector("pi-settings .pi-resource-scroll").textContent, /context-mode|todo-discipline/);
  assert.equal(root.querySelector("[data-setting='piProfile']").value, "https://github.com/bry-guy/dotfiles");
  assert.match(root.querySelector("[data-setting='piPackages']").value, /npm:context-mode/);
  const refreshProfile = root.querySelector("pi-settings [data-act='refresh-pi-configuration']");
  assert.ok(refreshProfile);
  refreshProfile.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-settings").textContent, /Pi profile refreshed/);
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

  root.querySelector("pi-header [data-act='files']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  let fileTarget = root.querySelector(".file-target");
  assert.ok(root.querySelector(".file-tree-target"));
  assert.equal(fileTarget.getAttribute("aria-label"), "Diff target");
  assert.equal(fileTarget.value, "none");
  assert.match(fileTarget.selectedOptions[0].textContent, /Working tree/);
  assert.ok(root.querySelector("pi-files [data-file='README.md']"));
  assert.ok(root.querySelector("pi-files .file-row.status-new[data-file='new.js']"));
  fileTarget.value = "HEAD";
  fileTarget.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.fileTarget, "HEAD");
  const readmeRow = root.querySelector("pi-files [data-file='README.md']");
  assert.ok(readmeRow);
  assert.equal(readmeRow.classList.contains("status-modified"), false);
  assert.ok(root.querySelector("pi-files .file-row.status-new[data-file='new.js']"));
  assert.ok(root.querySelector("pi-files .file-row.status-removed"));
  assert.ok(root.querySelector("pi-files .file-row.dir.status-modified[data-dir='src']"));
  root.querySelector("pi-files [data-dir='src']").click();
  assert.ok(root.querySelector("pi-files [data-file='src/untouched.js']"));
  assert.ok(root.querySelector("pi-files .file-row.status-modified[data-file='src/app.js']"));
  const treeScroll = root.querySelector(".files-scroll");
  treeScroll.scrollTop = 37;
  treeScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files .file-viewer"));
  assert.equal(root.querySelector("pi-files .file-viewer .file-target"), null);
  assert.equal(root.querySelector("pi-files [data-act='back']"), null);
  assert.equal(root.querySelector(".file-code"), null);
  assert.equal(root.querySelector(".file-section-head")?.textContent, "Diff");
  assert.match(root.querySelector(".file-diff-body")?.textContent || "", /const answer/);
  assert.match(root.querySelector(".file-diff-meta")?.textContent || "", /HEAD/);
  root.querySelector("pi-files .file-viewer [data-act='close']").click();
  assert.equal(store.state.filePath, null);
  assert.ok(root.querySelector("pi-files .files:not(.file-viewer)"));
  assert.equal(root.querySelector(".files-scroll").scrollTop, 37);
  fileTarget = root.querySelector(".file-target");
  fileTarget.value = "none";
  fileTarget.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-file='README.md']"));
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector(".file-code .hljs-keyword"));
  assert.equal(root.querySelector(".file-diff-body"), null);
  const viewerScroll = root.querySelector(".file-view-scroll");
  viewerScroll.scrollTop = 73;
  viewerScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  assert.equal(viewerScroll.scrollTop, 73);
  root.querySelector("pi-files .file-viewer [data-act='close']").click();
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(root.querySelector(".file-view-scroll").scrollTop, 73);
  root.querySelector("pi-files .file-viewer [data-act='close']").click();
  root.querySelector("pi-files [data-act='close']").click();

  const sidebar = root.querySelector("pi-sidebar");
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  assert.equal(store.state.railOpen, false);
  assert.equal(sidebar.dataset.layout, "mini");
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  assert.equal(store.state.railOpen, true);
  assert.equal(sidebar.dataset.layout, "rail");
  assert.equal(sidebar.querySelector("[data-act='projects']"), null, "projects has no separate navigation entry");
  assert.equal(root.querySelector("[data-screen='projects']"), null, "projects has no separate screen");
  store.set({ view: "chat" });

  applyEvent({ v: 1, seq: 101, sessionId: "sibling", type: "user_record", record: { id: "u-sibling", role: "user", text: "recent sibling" } });
  assert.equal(store.state.projects[0].sessions[0].id, "sibling");

  const composer = root.querySelector("pi-composer");
  const textarea = composer.querySelector("textarea");
  textarea.value = "foo";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  root.querySelector("[data-id='sibling']").click();
  assert.equal(textarea.value, "", "a different session starts with its own draft");
  root.querySelector("[data-id='s1']").click();
  assert.equal(textarea.value, "foo", "returning to a session restores its draft");
  const shiftEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  textarea.dispatchEvent(shiftEnter);
  assert.equal(shiftEnter.defaultPrevented, false, "desktop Shift+Enter inserts a newline");
  assert.equal(store.transcript("s1").records.some(record => record.pending), false);
  const composingEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  textarea.dispatchEvent(composingEnter);
  assert.equal(composingEnter.defaultPrevented, false, "IME Enter confirms composition without sending");

  dom.setNarrowViewport(true);
  const mobileEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(mobileEnter);
  assert.equal(mobileEnter.defaultPrevented, false, "mobile Enter inserts a newline");
  assert.equal(store.transcript("s1").records.some(record => record.pending), false, "mobile Enter does not send");

  dom.setNarrowViewport(false);
  const desktopEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(desktopEnter);
  assert.equal(desktopEnter.defaultPrevented, true, "desktop Enter sends");
  assert.equal(store.transcript("s1").records.some(record => record.pending), true);

  dom.setNarrowViewport(true);
  const pendingBeforeButton = store.transcript("s1").records.filter(record => record.pending).length;
  textarea.value = "mobile button send";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  composer.querySelector(".send-btn").click();
  assert.equal(store.transcript("s1").records.filter(record => record.pending).length, pendingBeforeButton + 1);
  dom.setNarrowViewport(false);

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

  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null });
  store.state.transcripts.s1.records = [{
    id: "activity:agent:solo", role: "activity", kind: "agent", key: "agent:solo", status: "running",
    title: "Solo", summary: "Working without todos", items: [], source: "test",
  }];
  store.notify("transcript");
  assert.match(root.querySelector(".activity-stack .agent-panel")?.textContent || "", /Working without todos/);
  store.state.transcripts.s1.records = [];
  store.notify("transcript");
  applyEvent({ v: 1, seq: 104, sessionId: "s1", type: "activity", record: {
    id: "activity:todo:1", role: "activity", kind: "todo", key: "todo", status: "in_progress",
    title: "Todos", summary: "1/2 complete", source: "test",
    items: [
      { id: "1", subject: "done", status: "completed", activeForm: "", blockedBy: [] },
      { id: "2", subject: "<safe>", status: "in_progress", activeForm: "checking", blockedBy: [] },
    ],
  } });
  assert.match(root.querySelector(".todo-panel")?.textContent || "", /1\/2/);
  assert.equal(root.querySelector(".todo-panel .activity-body"), null);
  assert.equal(root.querySelector(".todo-panel safe"), null);
  root.querySelector(".todo-panel [data-activity-toggle]").click();
  assert.ok(root.querySelector(".todo-panel .activity-body"));
  assert.match(root.querySelector(".todo-panel")?.textContent || "", /checking/);
  applyEvent({ v: 1, seq: 105, sessionId: "s1", type: "turn_end", reason: "done" });
  assert.equal(root.querySelector(".todo-panel .activity-body"), null);
  applyEvent({ v: 1, seq: 106, sessionId: "s1", type: "activity", record: {
    id: "activity:agent:a1", role: "activity", kind: "agent", key: "agent:a1", status: "running",
    title: "Explore", summary: "Checking files…", items: [], source: "test",
  } });
  assert.match(root.querySelector(".activity-stack .agent-panel")?.textContent || "", /Checking files/);
  assert.equal(root.querySelector(".activity-inline .bh-name"), null);
  applyEvent({ v: 1, seq: 107, sessionId: "s1", type: "activity", record: {
    id: "activity:agent:a1", role: "activity", kind: "agent", key: "agent:a1", runId: "a1",
    groupId: "group-1", parentMessageId: "assistant-1", revision: 2, status: "completed",
    title: "Explore", activity: "", summary: "Found the files.", toolCount: 2,
    createdAt: "2026-08-22T00:00:00.000Z", startedAt: "2026-08-22T00:00:00.000Z",
    endedAt: "2026-08-22T00:00:01.000Z", items: [], source: "test",
  } });
  assert.equal(root.querySelector(".subagent-panel"), null, "completed agents leave the live activity surface");
  assert.match(root.querySelector(".activity-inline .bh-name")?.textContent || "", /Explore/);
  assert.doesNotMatch(root.querySelector(".activity-inline")?.textContent || "", /Found the files/);
  root.querySelector(".activity-inline [data-activity-toggle]").click();
  assert.match(root.querySelector(".activity-inline")?.textContent || "", /Found the files/);
  assert.match(root.querySelector(".activity-inline")?.textContent || "", /completed/);

  store.state.transcripts.s1.records.unshift({ id: "pending-1", pendingId: "client-1", role: "user", text: "optimistic", pending: true });
  store.notify("transcript");
  applyEvent({ v: 1, seq: 108, sessionId: "s1", type: "user_record", clientMessageId: "client-1", record: { id: "u-1", role: "user", text: "optimistic" } });
  assert.equal(root.querySelector(".delivery-status"), null);
  assert.ok(root.querySelector(".user-message-content"));
  assert.equal(store.state.transcripts.s1.records.some(record => record.pending), false);
  store.state.transcripts.s1.records.push({ id: "failed-1", role: "user", text: "failed", deliveryError: "provider unavailable" });
  store.notify("transcript");
  assert.equal(root.querySelector(".delivery-status")?.textContent, "ERROR: Unable to send.");
  applyEvent({ v: 1, seq: 109, sessionId: "s1", type: "activity", record: {
    id: "activity:compaction", role: "activity", kind: "status", key: "compaction", status: "running",
    title: "Compacting", summary: "context…", items: [], source: "pi",
  } });
  assert.equal(root.querySelector(".activity-status strong")?.textContent, "Compacting");
  assert.equal(root.querySelector(".activity-status span:last-child")?.textContent, "context…");
  assert.ok(root.querySelector(".activity-inline .activity-status"));
  assert.equal(root.querySelector(".activity-stack .activity-status"), null);
  assert.equal(store.state.transcripts.s1.compacting, true);
  assert.equal(root.querySelector(".send-btn").disabled, true);
  assert.match(root.querySelector("textarea").placeholder, /Compacting context/);

  store.state.projects[0].sessions[0].branch = "feat/ship";
  store.state.transcripts.s1.compacting = false;
  store.notify("state");
  applyEvent({ v: 1, seq: 110, sessionId: "s1", type: "turn_start", turnId: "t-error" });
  applyEvent({ v: 1, seq: 111, sessionId: "s1", type: "message_start", messageId: "a-error", role: "assistant" });
  applyEvent({ v: 1, seq: 112, sessionId: "s1", type: "turn_end", turnId: "t-error", reason: "errored", error: "Insufficient quota." });
  assert.equal(store.transcript("s1").streaming, false);
  assert.equal(root.querySelector(".turn-error")?.textContent, "ERROR: Insufficient quota.");
  assert.equal(root.querySelector(".pi-think"), null);

  const scroller = root.querySelector(".scrollable");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  store.state.transcripts.s1 = {
    records: [{ id: "latest", role: "assistant", text: "latest" }],
    streaming: false, seq: 1, scrollToLatest: true,
  };
  store.notify("transcript");
  assert.equal(scroller.scrollTop, 1200);

  const longRecords = Array.from({ length: 1020 }, (_, index) => ({
    id: `long-${index}`, role: "assistant", text: `message ${index}`,
  }));
  store.state.transcripts.s1 = { records: longRecords, streaming: false, seq: 320 };
  store.notify("transcript");
  const thread = root.querySelector("pi-thread");
  const initialRendered = thread.querySelectorAll(".assist").length;
  assert.ok(initialRendered < longRecords.length);
  assert.match(thread.textContent, /message 1019/);
  assert.doesNotMatch(thread.textContent, /message 0/);
  assert.equal(thread.querySelector("[data-load-earlier]"), null);
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new dom.window.Event("scroll"));
  assert.ok(thread.querySelectorAll(".assist").length > initialRendered);

  store.set({ workspaceSettingsOpen: false });
  root.querySelector("pi-header [data-act='workspace-settings']")?.click();
  assert.ok(root.querySelector(".session-picker"));
  assert.ok(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']"));
  root.querySelector("[data-act='close-session-picker']")?.click();

  dom.window.__holdMerge = true;
  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null, sessionPicker: null, confirm: null });
  root.querySelector("pi-header [data-act='workspace-settings']").click();
  root.querySelector("[data-act='merge-branch']").click();
  root.querySelector(".confirm-modal [data-act='go']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.querySelector(".confirm-progress .operation-dot"));
  const mergeOperation = store.state.operations.find(operation => operation.kind === "merge" && operation.sessionId === "s1");
  applyEvent({ type: "operation_log", operationId: mergeOperation.id, event: { at: Date.now(), type: "phase", message: "Running git merge." } });
  assert.match(root.querySelector(".confirm-progress").textContent, /Running git merge/);
  assert.equal(root.querySelector(".confirm-progress").parentElement.classList.contains("confirm-actions"), true);
  assert.equal(root.querySelector(".confirm-progress").previousElementSibling.classList.contains("confirm-button-row"), true);
  dom.window.__mergeFails = true;
  root.querySelector(".confirm-modal [data-act='cancel']").click();
  assert.equal(root.querySelector(".confirm-modal"), null);
  dom.window.__resolveMerge();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".confirm-modal"), null, "a dismissed merge does not resurrect its error modal");
  assert.match(store.state.error, /http_502/);
  dom.window.__holdMerge = false;
  dom.window.__mergeFails = false;

  const closeButton = root.querySelector("[data-id='sibling'] .row-close");
  assert.ok(closeButton);
  closeButton.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.confirm, null, "Closing a session does not open a warning modal");
  assert.equal(root.querySelector(".confirm-modal"), null);
  assert.equal(root.querySelector(".operation-modal"), null, "closing a session does not open a terminal modal");
  root.querySelector("pi-settings [data-act='open-logs']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector(".logs-modal").textContent, /Session closed/);
  assert.doesNotMatch(root.querySelector(".logs-modal").textContent, /pi close/);
  root.querySelector("[data-act='close-logs']").click();

  dom.window.close();
});
