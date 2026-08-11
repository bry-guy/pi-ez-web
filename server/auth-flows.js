import { randomUUID } from "node:crypto";

const FLOW_TTL_MS = 20 * 60 * 1000;
const TERMINAL_TTL_MS = 60 * 1000;
const MAX_TEXT = 600;

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function clipped(value, max = MAX_TEXT) {
  return String(value ?? "").slice(0, max);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function sanitizePrompt(id, prompt) {
  if (!prompt || !["text", "secret", "select", "manual_code"].includes(prompt.type)) {
    throw coded("unsupported_auth_prompt");
  }
  const result = {
    id,
    type: prompt.type,
    message: clipped(prompt.message),
  };
  if (prompt.placeholder) result.placeholder = clipped(prompt.placeholder, 300);
  if (prompt.type === "select") {
    result.options = (prompt.options || []).slice(0, 20).map(option => ({
      id: clipped(option.id, 120),
      label: clipped(option.label, 200),
      ...(option.description ? { description: clipped(option.description, 300) } : {}),
    }));
  }
  return result;
}

function sanitizeNotification(event) {
  if (!event || typeof event.type !== "string") return null;
  if (event.type === "info" || event.type === "progress") {
    return {
      type: event.type,
      message: clipped(event.message),
      ...(event.type === "info" && Array.isArray(event.links)
        ? { links: event.links.slice(0, 5).flatMap(link => {
          const url = safeHttpUrl(link.url);
          return url ? [{ url, label: clipped(link.label || "Open link", 100) }] : [];
        }) }
        : {}),
    };
  }
  if (event.type === "auth_url") {
    const url = safeHttpUrl(event.url);
    if (!url) return { type: "info", message: "The provider returned an invalid authorization URL." };
    return {
      type: "auth_url",
      url,
      instructions: clipped(event.instructions || "Complete authentication in your browser."),
    };
  }
  if (event.type === "device_code") {
    const verificationUri = safeHttpUrl(event.verificationUri);
    return {
      type: "device_code",
      userCode: clipped(event.userCode, 120),
      verificationUri,
      ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
      ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
  }
  return null;
}

function redactedError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}

function safeLoginError(error) {
  if (error?.code === "auth_flow_timeout") {
    return { code: "auth_flow_timeout", message: "Provider login timed out. Try again." };
  }
  if (error?.code === "auth_flow_cancelled" || error?.name === "AbortError") {
    return { code: "auth_flow_cancelled", message: "Provider login was cancelled." };
  }
  return { code: "provider_login_failed", message: "Provider login did not complete. Try again." };
}

export class AuthFlow {
  constructor(manager, providerId, authType) {
    this.manager = manager;
    this.id = `f_${randomUUID()}`;
    this.providerId = providerId;
    this.authType = authType;
    this.state = "pending";
    this.controller = new AbortController();
    this.promptSequence = 0;
    this.pendingInput = null;
    this.publicPrompt = null;
    this.notification = null;
    this.error = null;
    this.timer = setTimeout(() => this.fail(coded("auth_flow_timeout")), FLOW_TTL_MS);
    this.timer.unref?.();
  }

  interaction() {
    return {
      signal: this.controller.signal,
      prompt: prompt => this.waitForInput(prompt),
      notify: event => {
        const notification = sanitizeNotification(event);
        if (notification) this.notification = notification;
      },
    };
  }

  waitForInput(prompt) {
    const id = `p_${++this.promptSequence}`;
    const publicPrompt = sanitizePrompt(id, prompt);
    return new Promise((resolve, reject) => {
      if (this.pendingInput) this.pendingInput.reject(coded("auth_prompt_replaced"));
      this.pendingInput = { id, type: publicPrompt.type, publicPrompt, resolve, reject };
      this.publicPrompt = publicPrompt;
      this.state = "waiting_input";
      if (prompt.signal) {
        const abort = () => {
          if (this.pendingInput?.id !== id) return;
          this.pendingInput = null;
          this.publicPrompt = null;
          reject(coded("auth_flow_cancelled"));
        };
        prompt.signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  submit(promptId, value) {
    const pending = this.pendingInput;
    if (!pending || pending.id !== promptId) throw coded("stale_auth_prompt");
    const text = typeof value === "string" ? value : "";
    if (pending.type === "select" && !pending.publicPrompt.options.some(option => option.id === text)) {
      throw coded("invalid_auth_option");
    }
    this.pendingInput = null;
    this.publicPrompt = null;
    this.state = "pending";
    // Do not retain the submitted value in the flow. It only exists in the
    // promise continuation owned by the Pi SDK login implementation.
    pending.resolve(text);
  }

  onTerminal() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.manager.remove(this.id), TERMINAL_TTL_MS);
    this.timer.unref?.();
  }

  async run(login) {
    try {
      await login(this.interaction());
      if (this.state !== "cancelled") this.state = "complete";
    } catch (error) {
      if (this.state === "error") {
        // fail() already recorded a timeout or other terminal error.
      } else if (this.controller.signal.aborted || error?.code === "auth_flow_cancelled" || error?.name === "AbortError") {
        this.state = "cancelled";
        this.error = { code: "auth_flow_cancelled", message: "Provider login was cancelled." };
      } else {
        this.state = "error";
        this.error = safeLoginError(error);
        console.error("pi-ez-web provider login failed", {
          flowId: this.id,
          providerId: this.providerId,
          error: redactedError(error),
        });
      }
    } finally {
      if (this.pendingInput) {
        this.pendingInput.reject(coded("auth_flow_cancelled"));
        this.pendingInput = null;
        this.publicPrompt = null;
      }
      this.onTerminal();
      this.manager.clearActive(this.id);
    }
  }

  fail(error) {
    if (["complete", "error", "cancelled"].includes(this.state)) return;
    this.error = safeLoginError(error);
    this.state = "error";
    this.controller.abort();
    if (this.pendingInput) this.pendingInput.reject(error);
    this.pendingInput = null;
    this.publicPrompt = null;
    this.onTerminal();
    this.manager.clearActive(this.id);
  }

  cancel() {
    if (["complete", "error", "cancelled"].includes(this.state)) return;
    this.controller.abort();
    this.state = "cancelled";
    this.error = { code: "auth_flow_cancelled", message: "Provider login was cancelled." };
    if (this.pendingInput) this.pendingInput.reject(coded("auth_flow_cancelled"));
    this.pendingInput = null;
    this.publicPrompt = null;
    this.onTerminal();
    this.manager.clearActive(this.id);
  }

  view() {
    return {
      id: this.id,
      providerId: this.providerId,
      authType: this.authType,
      state: this.state,
      ...(this.publicPrompt ? { prompt: this.publicPrompt } : {}),
      ...(this.notification ? { notification: this.notification } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

export class AuthFlowManager {
  constructor(supervisor) {
    this.supervisor = supervisor;
    this.flows = new Map();
    this.activeId = null;
  }

  clearActive(id) {
    if (this.activeId === id) this.activeId = null;
  }

  remove(id) {
    const flow = this.flows.get(id);
    if (flow && !["complete", "error", "cancelled"].includes(flow.state)) flow.cancel();
    this.flows.delete(id);
    this.clearActive(id);
  }

  get(id) {
    const flow = this.flows.get(id);
    if (!flow) throw coded("no_such_auth_flow");
    return flow;
  }

  async start(providerId, authType) {
    if (this.activeId) throw coded("auth_flow_active");
    const provider = (await this.supervisor.listProviders()).find(item => item.id === providerId);
    if (!provider) throw coded("no_such_provider");
    if (!provider.authMethods?.some(method => method.id === authType)) {
      throw coded("unsupported_auth_type");
    }
    const flow = new AuthFlow(this, providerId, authType);
    this.flows.set(flow.id, flow);
    this.activeId = flow.id;
    void flow.run(interaction => this.supervisor.loginProvider(providerId, authType, interaction));
    return flow;
  }
}

export { coded as authFlowError };
