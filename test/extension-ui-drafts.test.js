import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

let dom;
let api;
let store;
let root;
let originalSetError;
const globals = {};
const apiMethods = {};
const importIntervals = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount(request, sessionId = request.sessionId) {
  store.state.sessionId = sessionId;
  store.state.chatId = null;
  store.state.extensionUi = request;
  root = document.createElement("pi-extension-ui");
  document.body.append(root);
  return root;
}

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://pi-web.test/", pretendToBeVisual: true });
  for (const name of ["window", "document", "HTMLElement", "customElements", "Node", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "matchMedia", "requestAnimationFrame"]) {
    globals[name] = globalThis[name];
  }
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
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    importIntervals.push(timer);
    return timer;
  };
  try {
    ({ api } = await import("../public/js/api.js"));
    ({ store } = await import("../public/js/store.js"));
    await import("../public/js/panels.js");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  originalSetError = store.setError;
  apiMethods.extensionUiResponse = api.extensionUiResponse;
  apiMethods.extensionUiCancel = api.extensionUiCancel;
});

beforeEach(() => {
  api.extensionUiResponse = async () => ({ ok: true });
  api.extensionUiCancel = async () => ({ ok: true });
});

afterEach(() => {
  root?.remove();
  root = null;
  store.state.extensionUi = null;
  store.state.sessionId = null;
  store.state.chatId = null;
  store.state.error = null;
  store.setError = originalSetError;
  api.extensionUiResponse = apiMethods.extensionUiResponse;
  api.extensionUiCancel = apiMethods.extensionUiCancel;
});

after(() => {
  for (const timer of importIntervals) clearInterval(timer);
  dom.window.close();
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

test("input and editor drafts retain value, focus, and caret through updates and failure", async () => {
  for (const method of ["input", "editor"]) {
    const request = { sessionId: "s1", requestId: method, method, prefill: "original" };
    const element = mount(request);
    const field = element.querySelector("[data-extension-ui-value]");
    assert.equal(document.activeElement, field);
    field.value = "typed draft";
    field.focus();
    field.setSelectionRange(2, 7, "backward");

    store.notify("state");
    assert.equal(element.querySelector("[data-extension-ui-value]"), field);
    assert.equal(document.activeElement, field);
    assert.deepEqual([field.selectionStart, field.selectionEnd, field.selectionDirection], [2, 7, "backward"]);

    const response = deferred();
    api.extensionUiResponse = () => response.promise;
    store.setError = message => {
      store.state.error = message;
      store.notify("state");
    };
    const pending = element.submit({ value: field.value });
    let current = element.querySelector("[data-extension-ui-value]");
    assert.equal(current.value, "typed draft");
    assert.equal(current.readOnly, true);
    assert.equal(document.activeElement, current);
    assert.deepEqual([current.selectionStart, current.selectionEnd, current.selectionDirection], [2, 7, "backward"]);

    store.set({ extensionUi: { ...request, title: "Updated title" } });
    current = element.querySelector("[data-extension-ui-value]");
    assert.equal(current.value, "typed draft");
    assert.equal(document.activeElement, current);
    assert.deepEqual([current.selectionStart, current.selectionEnd, current.selectionDirection], [2, 7, "backward"]);

    response.reject(new Error("rejected"));
    await pending;
    current = element.querySelector("[data-extension-ui-value]");
    assert.equal(current.value, "typed draft");
    assert.equal(document.activeElement, current);
    assert.deepEqual([current.selectionStart, current.selectionEnd, current.selectionDirection], [2, 7, "backward"]);
    store.notify("state");
    assert.equal(element.querySelector("[data-extension-ui-value]").value, "typed draft");
    element.remove();
    root = null;
  }
});

test("successful submit and cancellation reset drafts before reopening", async () => {
  const request = { sessionId: "s1", requestId: "reopen", method: "input", prefill: "prefill" };
  const element = mount(request);
  element.querySelector("[data-extension-ui-value]").value = "submitted";
  await element.submit({ value: "submitted" });
  assert.equal(store.state.extensionUi, null);

  store.set({ extensionUi: request });
  let field = element.querySelector("[data-extension-ui-value]");
  assert.equal(field.value, "prefill");
  field.value = "cancelled draft";
  await element.cancel();
  assert.equal(store.state.extensionUi, null);

  store.set({ extensionUi: request });
  field = element.querySelector("[data-extension-ui-value]");
  assert.equal(field.value, "prefill");
  field.value = "session-bound draft";
  store.set({ sessionId: "s2" });
  assert.equal(element.querySelector(".extension-ui-modal"), null);
  store.set({ sessionId: "s1" });
  assert.equal(element.querySelector("[data-extension-ui-value]").value, "prefill");
});

test("replacement request resets drafts and obsolete completion cannot release new busy state", async () => {
  for (const rejectOld of [false, true]) {
    const oldResponse = deferred();
    const newResponse = deferred();
    let calls = 0;
    api.extensionUiResponse = () => (++calls === 1 ? oldResponse.promise : newResponse.promise);
    const element = mount({ sessionId: "s1", requestId: "old", method: "input", prefill: "old prefill" });
    element.querySelector("[data-extension-ui-value]").value = "old draft";
    const oldSubmit = element.submit({ value: "old draft" });

    store.set({ extensionUi: { sessionId: "s1", requestId: "new", method: "input", prefill: "new prefill" } });
    let field = element.querySelector("[data-extension-ui-value]");
    assert.equal(field.value, "new prefill");
    assert.equal(field.readOnly, false);
    field.value = "new draft";
    const newSubmit = element.submit({ value: field.value });
    assert.equal(element.querySelector("[data-extension-ui-value]").readOnly, true);
    store.setError = message => {
      store.state.error = message;
      store.notify("state");
    };

    if (rejectOld) oldResponse.reject(new Error("obsolete failure"));
    else oldResponse.resolve({ ok: true });
    await oldSubmit;
    field = element.querySelector("[data-extension-ui-value]");
    assert.equal(store.state.extensionUi.requestId, "new");
    assert.equal(field.value, "new draft");
    assert.equal(field.readOnly, true);
    assert.equal(store.state.error, null);

    newResponse.resolve({ ok: true });
    await newSubmit;
    assert.equal(store.state.extensionUi, null);
    element.remove();
    root = null;
  }
});

test("session identity resets drafts even when request IDs match", async () => {
  const oldCancel = deferred();
  api.extensionUiCancel = () => oldCancel.promise;
  const element = mount({ sessionId: "s1", requestId: "same", method: "input", prefill: "session one" });
  element.querySelector("[data-extension-ui-value]").value = "session one draft";
  const cancel = element.cancel();

  store.set({ sessionId: "s2", extensionUi: { sessionId: "s2", requestId: "same", method: "input", prefill: "session two" } });
  let field = element.querySelector("[data-extension-ui-value]");
  assert.equal(field.value, "session two");
  assert.equal(field.readOnly, false);
  const newResponse = deferred();
  api.extensionUiResponse = () => newResponse.promise;
  field.value = "session two draft";
  const submit = element.submit({ value: field.value });

  oldCancel.resolve({ ok: true });
  await cancel;
  field = element.querySelector("[data-extension-ui-value]");
  assert.equal(store.state.extensionUi.sessionId, "s2");
  assert.equal(field.value, "session two draft");
  assert.equal(field.readOnly, true);

  newResponse.resolve({ ok: true });
  await submit;
  assert.equal(store.state.extensionUi, null);
});

test("select options and confirm requests keep their existing submit flows", async () => {
  const responses = [];
  api.extensionUiResponse = async (sessionId, requestId, body) => responses.push({ sessionId, requestId, body });
  const element = mount({ sessionId: "s1", requestId: "select", method: "select", options: ["first", "second"] });
  const options = element.querySelectorAll("[data-extension-ui-option]");
  assert.equal(document.activeElement, options[0]);
  options[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses[0], { sessionId: "s1", requestId: "select", body: { value: "second" } });

  store.set({ extensionUi: { sessionId: "s1", requestId: "confirm", method: "confirm", message: "Proceed?" } });
  element.querySelector("[data-extension-ui-submit]").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses[1], { sessionId: "s1", requestId: "confirm", body: { confirmed: true } });
});
