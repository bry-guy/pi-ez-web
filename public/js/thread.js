import { api, openTranscript, refreshState } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { store } from "./store.js";
import { esc, newChat, newProjectSession, selectSession } from "./shell.js";

let pendingMessageSequence = 0;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LIVE_AGENT_STATUSES = new Set(["pending", "in_progress", "running", "queued"]);
const HISTORY_PAGE_SIZE = 150;
const liveAgent = record => record?.role === "activity"
  && record.kind === "agent" && LIVE_AGENT_STATUSES.has(record.status);

/* ---------------- thread ---------------- */
class PiThread extends HTMLElement {
  connectedCallback() {
    this.renderCache = new WeakMap();
    this.unsub = store.subscribe(w => {
      if (w === "state" || w === "transcript") this.render();
      else if (w === "delta:" + store.activeKey()) this.applyDelta();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-toggle], [data-activity-toggle]")) {
        e.preventDefault(); e.target.closest("[data-toggle], [data-activity-toggle]").click();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async onClick(e) {
    const fork = e.target.closest("[data-fork]");
    if (fork) return this.fork(fork.dataset.fork);
    const loadEarlier = e.target.closest("[data-load-earlier]");
    if (loadEarlier) {
      this.loadEarlier();
      return;
    }
    const activityToggle = e.target.closest("[data-activity-toggle]");
    if (activityToggle) {
      const key = activityToggle.dataset.activityToggle;
      const open = store.state.openActivity[key] ?? (key === "todo");
      store.state.openActivity[key] = !open;
      this.render();
      return;
    }
    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const id = tog.dataset.toggle;
      store.state.openTools[id] = !this.isOpen(id);
      this.render();
    }
  }

  async fork(recordId) {
    const id = store.state.sessionId;
    if (!id) return;
    const rec = store.transcript().records.find(r => r.id === recordId);
    try {
      const result = await api.fork(id, recordId);
      const childId = result.id;
      await refreshState();
      store.state.openTree[id] = true;
      selectSession(store.state.projectId, childId);
      store.setDraft(rec?.text || "");
      store.set({ hookResult: result.setup || null });
    } catch (err) {
      store.setError(`Fork failed: ${err.error || err.message || err}`);
    }
  }

  isOpen(id) { return store.state.openTools[id] ?? false; }

  applyDelta() {
    if (this.deltaFrame !== undefined) return;
    const now = globalThis.performance?.now?.() || Date.now();
    const elapsed = now - (this.lastDeltaRender || 0);
    if (elapsed < 32) {
      const run = () => { this.deltaFrame = undefined; this.applyDeltaNow(); };
      this.deltaFrame = globalThis.requestAnimationFrame ? requestAnimationFrame(run) : setTimeout(run, 32 - elapsed);
      return;
    }
    this.applyDeltaNow();
  }

  applyDeltaNow() {
    this.lastDeltaRender = globalThis.performance?.now?.() || Date.now();
    const holder = this.querySelector("[data-live-text]");
    const recs = store.transcript().records;
    const last = [...recs].reverse().find(r => r.role === "assistant" && r.streaming);
    if (!holder || !last) return this.render();
    const body = holder.querySelector(".markdown-content");
    if (!body) return this.render();
    body.innerHTML = renderMarkdown(last.text);
    const think = this.querySelector(".pi-think");
    if (think && last.text) this.render(); // thinking -> streaming transition
    this.autoscroll();
  }

  autoscroll(force = false) {
    const sc = this.closest(".scrollable") || this;
    if (!force && sc.scrollHeight - sc.scrollTop - sc.clientHeight >= 160) return;
    sc.scrollTop = sc.scrollHeight;
    if (force) {
      const raf = globalThis.requestAnimationFrame || this.ownerDocument?.defaultView?.requestAnimationFrame?.bind(this.ownerDocument.defaultView);
      raf?.(() => { if (this.isConnected) sc.scrollTop = sc.scrollHeight; });
    }
  }

  loadEarlier() {
    const scroller = this.closest(".scrollable") || this;
    const beforeHeight = scroller.scrollHeight;
    const beforeTop = scroller.scrollTop;
    this.historyLimit += HISTORY_PAGE_SIZE;
    this.render();
    scroller.scrollTop = beforeTop + scroller.scrollHeight - beforeHeight;
  }

  historyRecords(records) {
    const limit = this.historyLimit || HISTORY_PAGE_SIZE;
    if (records.length <= limit) return { records, hasEarlier: false };
    const keep = new Set(records.slice(-limit));
    for (const record of records) {
      if (record.role === "activity" || record.pending || record.deliveryError || record.streaming) keep.add(record);
    }
    const selected = records.filter(record => keep.has(record));
    return { records: selected, hasEarlier: selected.length < records.length };
  }

  render() {
    const activeKey = store.activeKey();
    const t = activeKey ? (store.state.transcripts[activeKey] || store.transcript(activeKey)) : null;
    if (activeKey !== this.renderedKey || t !== this.renderedTranscript) {
      this.renderedKey = activeKey;
      this.renderedTranscript = t;
      this.historyLimit = HISTORY_PAGE_SIZE;
      this.scrollOnNextRender = true;
    }
    if (!activeKey) { this.innerHTML = ""; return; }
    const noFork = !!store.state.chatId;
    if (!activeKey) { this.innerHTML = ""; return; }
    const visibleRecords = t.records.filter(record => record.role !== "activity"
      || record.key === "compaction"
      || (record.kind === "agent" && !liveAgent(record)));
    const liveAssistant = [...visibleRecords].reverse().find(record => record.role === "assistant" && record.streaming);
    // There can be a real gap between turn_start and message_start, and again
    // between an assistant message/tool call and the next assistant message.
    // Keep the thinking indicator tied to the turn rather than to the presence
    // of an empty assistant record so those gaps remain visible.
    const thinking = t.streaming && !liveAssistant;
    const activity = this.renderActivity(t.records);
    const notice = this.renderCommandNotice();
    const history = this.historyRecords(visibleRecords);
    if (visibleRecords.length === 0 && !activity && !notice && !thinking) {
      this.innerHTML = `<div class="empty-pi"><div class="tile">π</div></div>`;
      return;
    }
    const records = history.records.map(m => this.renderRecordCached(m, noFork)).join("");
    const earlier = history.hasEarlier
      ? `<div class="history-loader"><button type="button" data-load-earlier>Load earlier messages</button></div>`
      : "";
    const indicator = thinking
      ? `<div class="msg"><div class="pi-think" role="status" aria-label="Thinking"><span></span><span></span><span></span></div></div>`
      : "";
    this.innerHTML = earlier + records + indicator + activity + notice;
    const forceScroll = this.scrollOnNextRender || !!t.scrollToLatest;
    this.autoscroll(forceScroll);
    delete t.scrollToLatest;
    this.scrollOnNextRender = false;
  }

  renderActivity(records) {
    const latest = new Map();
    for (const record of records) {
      if (record.role === "activity" && record.key) latest.set(record.key, record);
    }
    const todo = latest.get("todo");
    const agents = [...latest.values()].filter(liveAgent);
    const todoItems = (todo?.items || []).filter(item => item.status !== "deleted");
    const todoDone = todoItems.filter(item => item.status === "completed").length;
    const todoRows = todoItems.map(item => {
      const status = item.status === "completed" ? "done" : item.status === "in_progress" ? "active" : "pending";
      const label = item.status === "in_progress" ? item.activeForm || item.subject : item.subject;
      return `<div class="activity-task ${status}"><span class="activity-glyph">${status === "done" ? "✓" : status === "active" ? "◐" : "○"}</span><span>${esc(label)}</span></div>`;
    }).join("");
    const panel = (key, title, meta, body, defaultOpen) => {
      const open = store.state.openActivity[key] ?? defaultOpen;
      return `<section class="activity-panel ${key === "todo" ? "todo-panel" : "agent-panel"}" aria-label="${esc(title)}">
        <button class="activity-head" type="button" data-activity-toggle="${esc(key)}" aria-expanded="${open}">
          <strong>${esc(title)}</strong><span>${esc(meta)} <b class="activity-caret">${open ? "▾" : "▸"}</b></span>
        </button>${open ? `<div class="activity-body">${body}</div>` : ""}
      </section>`;
    };
    const todoPanel = todoItems.length
      ? panel("todo", "Todos", `${todoDone}/${todoItems.length}`, todoRows, true)
      : "";
    const agentPanels = agents.map(agent => panel(
      agent.key,
      agent.title || "Background agent",
      agent.status === "queued" ? "queued" : "in progress",
      `<div class="agent-progress"><span class="activity-glyph">◐</span><div class="agent-progress-summary markdown-content">${renderMarkdown(agent.summary || "Background agent is working…")}</div></div>`,
      true,
    )).join("");
    if (!todoPanel && !agentPanels) return "";
    return `<div class="activity-stack">${todoPanel}${agentPanels}</div>`;
  }

  renderCommandNotice() {
    const notice = store.state.commandNotice;
    if (!notice || notice.sessionId !== store.activeKey()) return "";
    const stats = notice.stats;
    const message = stats
      ? `Messages ${stats.messages} · user ${stats.user} · assistant ${stats.assistant} · tools ${stats.tools} · tokens ${stats.tokens?.total || 0} · cost ${Number(stats.cost || 0).toFixed(4)}`
      : notice.message || "";
    return `<section class="command-notice" role="status"><strong>${esc(notice.title || "Pi")}</strong><span>${esc(message)}</span></section>`;
  }

  renderRecordCached(m, noFork) {
    const open = m.role === "tool" || m.role === "diff"
      ? this.isOpen(m.id)
      : m.role === "activity" ? (store.state.openActivity[m.key] ?? false) : false;
    const cached = this.renderCache.get(m);
    const signature = [m.role, m.id, m.key, m.status, m.title, m.summary, m.text, m.streaming, m.pending, m.deliveryError, m.meta, m.file, m.add, m.del, m.cmd, open, open ? m.out : null];
    if (cached?.noFork === noFork && cached.signature.length === signature.length
      && cached.signature.every((value, index) => value === signature[index])) return cached.html;
    const html = this.renderRecord(m, noFork);
    this.renderCache.set(m, { noFork, signature, html });
    return html;
  }

  renderRecord(m, noFork) {
    if (m.role === "activity" && m.key === "compaction") {
      const status = m.status || "completed";
      return `<div class="msg activity-inline"><div class="activity-status ${esc(status)}" role="status" aria-live="polite">
        <span class="activity-status-glyph">${status === "running" ? "◐" : status === "completed" ? "✓" : "!"}</span>
        <strong>${esc(m.title || "Context compaction")}</strong><span>${esc(m.summary || "")}</span>
      </div></div>`;
    }
    if (m.role === "activity" && m.kind === "agent") {
      const open = store.state.openActivity[m.key] ?? false;
      return `<div class="msg activity-inline"><div class="block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-activity-toggle="${esc(m.key)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span><span class="bh-name">${esc(m.title || "Activity")}</span>
          <span class="bh-arg">background activity</span><span class="bh-meta">${esc(m.status || "completed")}</span>
        </div>${open ? `<div class="activity-inline-body markdown-content">${renderMarkdown(m.summary || "")}</div>` : ""}
      </div></div>`;
    }
    if (m.role === "user") {
      const delivery = m.deliveryError ? "ERROR: Unable to send." : "";
      return `<div class="msg ${noFork ? "no-fork" : ""} ${m.deliveryError ? "delivery-failed" : ""}">
        <div class="msg-user-row">
          ${m.pending || m.deliveryError ? "" : `<button class="fork-btn" data-fork="${esc(m.id)}" title="Fork"><span class="sigil">⑂</span><span class="word">fork</span></button>`}
          <div class="user-message-content"><div class="bubble">${(m.images || []).map(image => `<img class="message-image" src="data:${esc(image.mimeType)};base64,${esc(image.data)}" alt="Attached image">`).join("")}${m.text ? `<div>${esc(m.text)}</div>` : ""}</div>${delivery ? `<div class="delivery-status">${esc(delivery)}</div>` : ""}</div>
        </div></div>`;
    }
    if (m.role === "error") {
      return `<div class="msg"><div class="turn-error" role="alert">ERROR: ${esc(m.text || "Service unavailable.")}</div></div>`;
    }
    if (m.role === "assistant") {
      const thinking = m.streaming && !m.text;
      const caret = m.streaming && m.text;
      if (thinking) {
        return `<div class="msg"><div class="pi-think" role="status" aria-label="Thinking"><span></span><span></span><span></span></div></div>`;
      }
      return `<div class="msg"><div class="assist" ${m.streaming ? "data-live-text" : ""}><div class="markdown-content">${renderMarkdown(m.text)}</div>${caret ? `<span class="caret-bar"></span>` : ""}</div></div>`;
    }
    if (m.role === "tool") {
      const open = this.isOpen(m.id);
      return `<div class="msg"><div class="block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${esc(m.id)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span>
          <span class="bh-name">${esc(m.tool)}</span>
          <span class="bh-arg">${esc(m.arg)}</span>
          <span class="bh-meta">${esc(m.meta)}</span>
        </div>
        ${open ? `<pre>${esc(m.out)}</pre>` : ""}
      </div></div>`;
    }
    if (m.role === "diff") {
      const open = this.isOpen(m.id);
      const lines = open ? (m.lines || []).map(l => {
        const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : l.sign === "" ? "hunk" : "";
        return `<div class="diff-line ${cls}"><span class="sign">${esc(l.sign)}</span>${esc(l.text)}</div>`;
      }).join("") : "";
      return `<div class="msg"><div class="block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${esc(m.id)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span>
          <span class="bh-name">edit</span>
          <span class="bh-arg rtl">${esc(m.file)}</span>
          <span class="bh-add">${esc(m.add)}</span>
          <span class="bh-del">${esc(m.del)}</span>
        </div>
        ${open ? `<div class="diff-body">${lines}</div>` : ""}
      </div></div>`;
    }
    if (m.role === "bang") {
      return `<div class="msg"><div class="block bang">
        <div class="block-head">
          <span class="sigil">!</span>
          <span class="bh-cmd">${esc(m.cmd)}</span>
          <span class="bh-meta">${esc(m.meta)}</span>
        </div>
        ${m.out ? `<pre>${esc(m.out)}</pre>` : ""}
      </div></div>`;
    }
    return "";
  }
}

/* ---------------- model picker ---------------- */
class PiModelPicker extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.focusedIndex = 0;
    this.mode = this.dataset.mode === "default" ? "default" : "session";
    this.onDocumentPointer = e => {
      if (this.open && !this.contains(e.target)) this.close();
    };
    this.onViewport = () => { if (this.open) this.positionPopover(); };
    document.addEventListener("pointerdown", this.onDocumentPointer);
    window.addEventListener("resize", this.onViewport);
    window.addEventListener("scroll", this.onViewport, true);
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => this.onKeyDown(e));
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("pointerdown", this.onDocumentPointer);
    window.removeEventListener("resize", this.onViewport);
    window.removeEventListener("scroll", this.onViewport, true);
  }
  current() {
    return this.mode === "default"
      ? store.state.defaultModel
      : store.state.model || store.state.effectiveDefaultModel || null;
  }
  close(returnFocus = false) {
    if (!this.open) return;
    this.open = false;
    this.render();
    if (returnFocus) this.querySelector("[data-model-toggle]")?.focus();
  }
  options() { return [...this.querySelectorAll("[data-model]:not([disabled]), [data-model-automatic]:not([disabled])")]; }
  optionValue(option) { return option?.hasAttribute("data-model-automatic") ? null : option?.dataset.model; }
  onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close(true);
      return;
    }
    const toggle = e.target.closest("[data-model-toggle]");
    if (!this.open) {
      if (toggle && ["ArrowDown", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        this.open = true;
        this.focusedIndex = 0;
        this.render();
        this.focusOption();
      }
      return;
    }
    const options = this.options();
    if (!options.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.focusedIndex = (this.focusedIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      this.focusOption();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.focusedIndex = e.key === "Home" ? 0 : options.length - 1;
      this.focusOption();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void this.choose(this.optionValue(options[this.focusedIndex]));
    }
  }
  focusOption() {
    const options = this.options();
    const option = options[this.focusedIndex];
    option?.focus();
    option?.scrollIntoView?.({ block: "nearest" });
  }
  onClick(e) {
    const toggle = e.target.closest("[data-model-toggle]");
    if (toggle) {
      this.open = !this.open;
      this.focusedIndex = 0;
      this.render();
      if (this.open) this.focusOption();
      return;
    }
    const automatic = e.target.closest("[data-model-automatic]");
    if (automatic) {
      void this.choose(null);
      return;
    }
    const option = e.target.closest("[data-model]");
    if (option && !option.disabled) void this.choose(option.dataset.model);
  }
  async choose(id) {
    const previous = this.current();
    this.open = false;
    if (this.mode === "default") store.set({ defaultModel: id });
    else store.set({ model: id });
    try {
      if (this.mode === "default") {
        const result = await api.settings(id);
        store.set({
          defaultModel: result.defaultModel ?? null,
          effectiveDefaultModel: result.effectiveDefaultModel ?? null,
          defaultModelStatus: result.defaultModelStatus || "automatic",
          modelError: result.modelError || null,
        });
      } else if (store.activeKey()) {
        await api.setModel(store.activeKey(), id);
      }
    } catch (err) {
      if (this.mode === "default") store.set({ defaultModel: previous });
      else store.set({ model: previous });
      store.setError(err.error === "model_unavailable"
        ? "That model is unavailable."
        : `Model change failed: ${err.message || err}`);
    }
  }
  positionPopover() {
    const popover = this.querySelector(".model-popover");
    const anchor = this.querySelector("[data-model-toggle]");
    if (!popover || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const headerAllowance = 42;
    const compactListCap = 220;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const width = Math.min(276, Math.max(0, viewportWidth - margin * 2));
    const aboveRoom = Math.max(0, a.top - margin);
    const belowRoom = Math.max(0, viewportHeight - a.bottom - margin);
    const above = aboveRoom >= belowRoom;
    const sideRoom = above ? aboveRoom : belowRoom;
    const listHeight = Math.min(compactListCap, Math.max(96, sideRoom - gap - headerAllowance));
    const maxPopoverHeight = Math.max(140, Math.min(viewportHeight - margin * 2, listHeight + headerAllowance));
    const height = Math.min(popover.getBoundingClientRect().height || maxPopoverHeight, maxPopoverHeight);
    const left = Math.max(margin, Math.min(a.right - width, viewportWidth - width - margin));
    const top = above
      ? Math.max(margin, a.top - height - gap)
      : Math.min(viewportHeight - margin - height, a.bottom + gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${maxPopoverHeight}px`;
    popover.querySelector(".model-list")?.style.setProperty("max-height", `${listHeight}px`);
  }
  render() {
    const current = this.current();
    const model = store.state.models.find(m => m.id === current);
    const configuredUnavailable = this.mode === "default" && current && !model && store.state.defaultModelStatus === "unavailable";
    const chipLabel = this.mode === "default"
      ? (model?.label || (configuredUnavailable ? `${current} (unavailable)` : "Automatic"))
      : (model?.label || current || "Automatic");
    const variant = this.dataset.variant === "settings" ? "settings-chip" : "model-chip";
    const groups = new Map();
    for (const m of store.state.models) {
      const key = m.provider || m.id.split("/")[0] || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const options = [...groups.entries()].map(([provider, models]) => `
      <div class="model-group" role="group" aria-label="${esc(provider)}">
        <div class="model-group-label">${esc(provider)}</div>
        ${models.map(m => `
          <button class="model-option ${m.id === current ? "current" : ""}" role="option"
            aria-selected="${m.id === current}" data-model="${esc(m.id)}">
            <span class="model-option-main">${esc(m.label || m.id)}</span>
            <span class="model-option-meta">${esc(m.provider || "")}</span>
            ${m.id === current ? `<span class="model-option-check">✓</span>` : ""}
          </button>`).join("")}
      </div>`).join("");
    const automatic = this.mode === "default" ? `
      <button class="model-option ${current === null ? "current" : ""}" role="option"
        aria-selected="${current === null}" data-model-automatic>
        <span class="model-option-main">Automatic</span>
        <span class="model-option-meta">first available model</span>
        ${current === null ? `<span class="model-option-check">✓</span>` : ""}
      </button>` : "";
    const unavailable = configuredUnavailable ? `
      <div class="model-unavailable">Configured model unavailable:<br><span>${esc(current)}</span></div>` : "";
    const empty = !options && !unavailable
      ? `<div class="model-empty">No models available.<br><span>Connect a provider in Settings.</span></div>` : "";
    const popoverId = this._popoverId ||= `model-popover-${Math.random().toString(36).slice(2, 9)}`;
    this.innerHTML = `<div class="model-picker">
      <button class="${variant}" data-model-toggle aria-haspopup="listbox" aria-controls="${popoverId}" aria-expanded="${this.open}"
        title="Choose model">${esc(chipLabel)}</button>
      ${this.open ? `<div id="${popoverId}" class="model-popover" role="dialog" aria-label="Choose model">
        <div class="model-popover-head">Choose model</div>
        <div class="model-list" role="listbox">${automatic}${unavailable}${options || empty}</div>
      </div>` : ""}
    </div>`;
    if (this.open) this.positionPopover();
  }
}

/* ---------------- context window ---------------- */
const tokenLabel = value => {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return "—";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));
};
class PiContextMeter extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.info = null;
    this.unsub = store.subscribe(w => {
      if (w === "state" || w === "transcript") this.sync();
    });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-context-toggle]")) {
        this.open = !this.open;
        this.render();
      }
    });
    this.sync();
  }
  disconnectedCallback() { this.unsub?.(); }
  async sync() {
    const id = store.activeKey();
    const transcript = store.transcript(id);
    const lastAssistant = [...transcript.records].reverse().find(record => record.role === "assistant");
    const key = `${id || ""}:${store.state.model || ""}:${transcript.streaming}:${lastAssistant?.id || ""}:${lastAssistant?.text?.length || 0}`;
    if (!id || key === this.contextKey) return;
    this.contextKey = key;
    try {
      const info = await api.context(id);
      if (id !== store.activeKey()) return;
      this.info = info;
      this.render();
    } catch {
      if (id === store.activeKey()) { this.info = null; this.render(); }
    }
  }
  render() {
    const info = this.info;
    if (!store.activeKey()) { this.innerHTML = ""; return; }
    const percent = Number.isFinite(info?.percent) ? info.percent : null;
    const tone = percent == null ? "unknown" : percent >= 85 ? "danger" : percent >= 70 ? "warn" : "ok";
    const label = percent == null ? "Context unavailable" : `Context ${tokenLabel(info.used)} / ${tokenLabel(info.window)} · ${percent}%`;
    const details = info && percent != null ? `<div class="context-popover" role="status">
      <strong>Context window</strong>
      <span>${tokenLabel(info.used)} used · ${tokenLabel(info.remaining)} remaining</span>
      <span>Input ${tokenLabel(info.input)} · cache ${tokenLabel((info.cacheRead || 0) + (info.cacheWrite || 0))}</span>
      ${info.model ? `<span>${esc(info.model)}</span>` : ""}
    </div>` : "";
    this.innerHTML = `<div class="context-meter ${tone}">
      <button data-context-toggle aria-expanded="${this.open}" title="Context window usage">
        <span>${label}</span>${percent != null ? `<i><b style="width:${percent}%"></b></i>` : ""}
      </button>
      ${this.open ? details : ""}
    </div>`;
  }
}

/* ---------------- thinking effort ---------------- */
class PiThinkingPicker extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.info = null;
    this.addEventListener("click", e => {
      const toggle = e.target.closest("[data-thinking-toggle]");
      if (toggle) { this.open = !this.open; this.render(); return; }
      const option = e.target.closest("[data-thinking-level]");
      if (option) void this.choose(option.dataset.thinkingLevel);
    });
    this.unsub = store.subscribe(w => { if (w === "state") this.sync(); });
    this.sync();
  }
  disconnectedCallback() { this.unsub?.(); }
  async sync() {
    const id = store.activeKey();
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.open = false;
    // Keep the effort control present even when a provider does not advertise
    // reasoning metadata. Pi will clamp unsupported choices server-side.
    this.info = { level: "medium", levels: THINKING_LEVELS, supported: true };
    this.render();
    try {
      const info = await api.thinking(id);
      if (id !== store.activeKey() || !Array.isArray(info.levels)) return;
      this.info = info.levels.length > 1
        ? info
        : { ...this.info, level: info.level || this.info.level };
      this.render();
    } catch { /* retain the available fallback while a server is restarting */ }
  }
  async choose(level) {
    const id = store.activeKey();
    if (!id) return;
    try {
      this.info = await api.setThinking(id, level);
      this.open = false;
      this.render();
    } catch (err) { store.setError(`Thinking effort change failed: ${err.message || err}`); }
  }
  render() {
    const info = this.info;
    if (!info?.levels?.length) { this.innerHTML = ""; return; }
    const level = info.level || "off";
    this.innerHTML = `<div class="thinking-picker">
      <button class="thinking-chip" data-thinking-toggle aria-haspopup="listbox" aria-expanded="${this.open}" title="Thinking effort">${esc(level)}</button>
      ${this.open ? `<div class="thinking-popover" role="listbox" aria-label="Thinking effort">
        <div class="thinking-popover-head">Thinking effort</div>
        ${info.levels.map(item => `<button class="thinking-option ${item === level ? "current" : ""}" role="option" aria-selected="${item === level}" data-thinking-level="${esc(item)}">${esc(item)}${item === level ? " <span>✓</span>" : ""}</button>`).join("")}
      </div>` : ""}
    </div>`;
  }
}

/* ---------------- composer ---------------- */
class PiComposer extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="composer-outer"><div class="composer-pad"><div class="composer">
      <div class="command-popover hidden" role="listbox" aria-label="Pi commands"></div>
      <div class="composer-attachments"></div>
      <textarea rows="2"></textarea>
      <pi-context-meter></pi-context-meter>
      <div class="composer-foot">
        <div class="attachment-picker">
          <input class="image-input" type="file" accept="image/*" multiple hidden>
          <button class="attach-btn" type="button" title="Attach images" aria-label="Attach images">＋</button>
        </div>
        <pi-model-picker data-mode="session" data-variant="composer"></pi-model-picker>
        <pi-thinking-picker></pi-thinking-picker>
        <button class="stop-btn hidden"><span class="sq"></span>Stop</button>
        <button class="send-btn" type="button" title="Send" aria-label="Send message">↑</button>
      </div>
    </div></div></div>`;
    this.ta = this.querySelector("textarea");
    this.attachments = [];
    this.attachmentsEl = this.querySelector(".composer-attachments");
    this.imageInput = this.querySelector(".image-input");
    this.attachBtn = this.querySelector(".attach-btn");
    this.stopBtn = this.querySelector(".stop-btn");
    this.sendBtn = this.querySelector(".send-btn");

    this.ta.addEventListener("input", () => {
      store.setDraft(this.ta.value);
      void this.syncCommands();
    });
    this.attachBtn.addEventListener("click", () => this.imageInput.click());
    this.imageInput.addEventListener("change", () => {
      void this.addFiles(this.imageInput.files);
      this.imageInput.value = "";
    });
    this.ta.addEventListener("paste", e => {
      const files = [...(e.clipboardData?.files || [])].filter(file => file.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); void this.addFiles(files); }
    });
    this.addEventListener("click", e => {
      const removeImage = e.target.closest("[data-remove-image]");
      if (removeImage) {
        this.attachments.splice(Number(removeImage.dataset.removeImage), 1);
        this.renderAttachments();
        return;
      }
      const option = e.target.closest("[data-command-index]");
      if (!option) return;
      this.commandIndex = Number(option.dataset.commandIndex);
      this.chooseCommand();
    });
    this.ta.addEventListener("keydown", e => {
      if (this.commandOpen && this.commandQuery() !== null && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
        if (e.key === "Escape") { e.preventDefault(); this.closeCommands(); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.moveCommand(e.key === "ArrowDown" ? 1 : -1); return; }
        const query = this.commandQuery();
        const exact = query && this.commands.some(command => command.name.toLowerCase() === query) && this.ta.value === `/${query}`;
        if (e.key === "Enter" && exact) { e.preventDefault(); this.closeCommands(); this.send(e.altKey ? "followUp" : undefined); return; }
        if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); this.chooseCommand(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(e.altKey ? "followUp" : undefined);
      }
    });
    this.sendBtn.addEventListener("pointerdown", e => {
      if (!store.transcript().streaming) return;
      this.sendHoldTimer = setTimeout(() => {
        this.sendHoldTimer = null;
        this.sendHeld = true;
        void this.send("followUp");
      }, 500);
      this.sendBtn.setPointerCapture?.(e.pointerId);
    });
    const cancelSendHold = () => {
      if (this.sendHoldTimer) clearTimeout(this.sendHoldTimer);
      this.sendHoldTimer = null;
    };
    this.sendBtn.addEventListener("pointerup", cancelSendHold);
    this.sendBtn.addEventListener("pointercancel", cancelSendHold);
    this.sendBtn.addEventListener("click", e => {
      e.preventDefault();
      if (this.sendHeld) { this.sendHeld = false; return; }
      void this.send();
    });
    this.stopBtn.addEventListener("click", () => api.stop(store.activeKey()).catch(err => store.setError(`Stop failed: ${err.message || err}`)));
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.sync(); });
    this.commands = [];
    this.allCommands = [];
    this.commandRequest = 0;
    this.commandOpen = false;
    this.commandIndex = 0;
    this.commandSessionId = null;
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    if (this.sendHoldTimer) clearTimeout(this.sendHoldTimer);
  }

  scrollToLatest() {
    const scroller = this.closest("pi-app")?.querySelector(".scrollable");
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  commandQuery() {
    const match = this.ta.value.match(/^\/([^\s]*)$/);
    return match ? match[1].toLowerCase() : null;
  }
  addPendingMessage(id, text, images) {
    const pendingId = `pending:${id}:${Date.now()}:${++pendingMessageSequence}`;
    store.transcript(id).records.push({ id: pendingId, pendingId, role: "user", text, images, pending: true });
    store.notify("transcript");
    return pendingId;
  }
  markPendingMessage(id, pendingId, message) {
    if (!pendingId) return;
    const record = store.transcript(id).records.find(item => item.pendingId === pendingId);
    if (!record) return;
    record.pending = false;
    record.deliveryError = message;
    store.notify("transcript");
  }
  async syncCommands() {
    const query = this.commandQuery();
    const id = store.activeKey();
    if (query === null || !id) { this.closeCommands(); return; }
    const request = ++this.commandRequest;
    try {
      if (id !== this.commandSessionId) {
        const result = await api.commands(id);
        if (request !== this.commandRequest || id !== store.activeKey() || this.commandQuery() === null) return;
        this.allCommands = result.commands || [];
        this.commandSessionId = id;
      }
      if (request !== this.commandRequest || id !== store.activeKey() || this.commandQuery() === null) return;
      this.commands = this.allCommands.filter(command => !query || command.name.toLowerCase().includes(query));
      this.commandIndex = 0;
      this.commandOpen = this.commands.length > 0;
      this.renderCommands();
    } catch {
      if (request === this.commandRequest) this.closeCommands();
    }
  }
  closeCommands() {
    this.commandOpen = false;
    this.renderCommands();
  }
  moveCommand(delta) {
    if (!this.commands.length) return;
    this.commandIndex = (this.commandIndex + delta + this.commands.length) % this.commands.length;
    this.renderCommands();
  }
  chooseCommand() {
    const command = this.commands[this.commandIndex];
    if (!command) return;
    if (!this.ta.value.startsWith("/")) return;
    this.ta.value = `/${command.name} `;
    store.setDraft(this.ta.value);
    this.closeCommands();
    this.ta.focus();
  }
  renderCommands() {
    const popover = this.querySelector(".command-popover");
    if (!popover) return;
    popover.classList.toggle("hidden", !this.commandOpen);
    popover.innerHTML = this.commands.map((command, index) => `<button class="command-option ${index === this.commandIndex ? "current" : ""}" data-command-index="${index}"><span>/${esc(command.name)}</span><small>${esc([command.description || command.source || "", command.argumentHint || ""].filter(Boolean).join(" "))}</small></button>`).join("");
  }

  async handleCommandResult(id, result) {
    const action = result?.action;
    if (action === "settings") { store.set({ view: "settings", commandNotice: null }); return; }
    if (action === "model-picker") {
      const picker = this.querySelector("pi-model-picker");
      if (picker) { picker.open = true; picker.focusedIndex = 0; picker.render(); picker.focusOption?.(); }
      return;
    }
    if (action === "download") {
      const link = document.createElement("a");
      link.href = api.exportSession(id, result.format || "html");
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
      store.set({ commandNotice: { sessionId: id, title: "Export", message: "Session download started." } });
      return;
    }
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(result.text || "");
        store.set({ commandNotice: { sessionId: id, title: "Copy", message: "Copied the last agent message." } });
      } catch {
        store.setError("Clipboard access is unavailable in this browser.");
      }
      return;
    }
    if (action === "share") {
      store.set({ commandNotice: { sessionId: id, title: "Share", message: result.url || "Private gist created." } });
      return;
    }
    if (action === "notice") {
      store.set({ commandNotice: { sessionId: id, title: result.title, message: result.message, stats: result.stats } });
      return;
    }
    if (action === "refresh") {
      await openTranscript(id);
      store.set({ commandNotice: result.notice === false ? null : { sessionId: id, title: "Pi", message: result.message || "Done." } });
      return;
    }
    if (action === "sidebar") { store.set({ railOpen: true, drawerOpen: true, commandNotice: null }); return; }
    if (action === "new") {
      if (store.state.chatId || !store.state.projectId) await newChat();
      else await newProjectSession(store.state.projectId);
      return;
    }
    if (action === "clone" || action === "fork") {
      const projectId = store.state.projectId;
      if (!projectId) { store.setError("Forking is available for project sessions."); return; }
      const user = [...store.transcript(id).records].reverse().find(record => record.role === "user");
      if (action === "fork" && !user) { store.setError("There is no user message to fork yet."); return; }
      const forked = await api.fork(id, action === "fork" ? user.id : undefined);
      await refreshState();
      store.state.openTree[id] = true;
      selectSession(projectId, forked.id);
      if (action === "fork") {
        store.setDraft(user.text || "");
        store.notify("state");
      }
      return;
    }
    if (action === "quit") {
      await api.close(id);
      return;
    }
    if (action) store.set({ commandNotice: { sessionId: id, title: "Pi", message: result.message || action } });
  }

  async addFiles(files) {
    for (const file of [...(files || [])]) {
      if (!file.type.startsWith("image/") || this.attachments.length >= 4) continue;
      if (file.size > 6_000_000) { store.setError("Images must be smaller than 6 MB."); continue; }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      this.attachments.push({ type: "image", data, mimeType: file.type, name: file.name });
    }
    this.renderAttachments();
  }
  renderAttachments() {
    this.attachmentsEl.innerHTML = this.attachments.map((image, index) => `<div class="attachment-thumb"><img src="data:${esc(image.mimeType)};base64,${esc(image.data)}" alt="${esc(image.name || "Attached image")}"><button type="button" data-remove-image="${index}" aria-label="Remove image">×</button></div>`).join("");
  }
  async send(forcedMode) {
    const id = store.activeKey();
    const text = this.ta.value.trim();
    if (!id || (!text && !this.attachments.length) || store.workspaceBusy(id) || store.transcript(id).compacting) return;
    const images = this.attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    const pendingId = !text.startsWith("/") && !text.startsWith("!")
      ? this.addPendingMessage(id, text, images)
      : null;
    this.scrollToLatest();
    this.ta.value = "";
    this.attachments = [];
    this.renderAttachments();
    store.setDraft("");
    store.set({ commandNotice: null });
    if (text.startsWith("!")) {
      try { await api.bang(id, text.slice(1).trim()); }
      catch (err) { store.setError(`Command failed: ${err.error || err.message || err}`); }
      return;
    }
    const streaming = store.transcript(id).streaming;
    const mode = forcedMode || (streaming ? "steer" : "prompt");
    try {
      if (text.startsWith("/")) {
        const result = await api.command(id, text, mode);
        await this.handleCommandResult(id, result);
      } else {
        await api.message(id, text, mode, images, pendingId);
        // The optimistic record is already visible; SSE replaces it with Pi's
        // canonical record when the server accepts the prompt.
      }
    } catch (err) {
      const message = err.error === "model_required"
        ? "No model is available."
        : err.error === "workspace_busy"
          ? "Workspace is busy."
          : err.error === "checkout_occupied"
            ? "Not sent: another session is using this workspace."
            : err.message || err.error || String(err);
      this.markPendingMessage(id, pendingId, message);
      if (err.error === "workspace_busy") {
        await refreshState().catch(refreshErr => store.setError(`Could not refresh state: ${refreshErr.message || refreshErr}`));
      } else if (err.error === "checkout_occupied") {
        store.setDraft(text);
        store.set({ confirm: {
          type: "bind", id, text, mode, branch: err.suggestedBranch,
          fromBranch: store.project()?.branch || "main", byTitle: err.byTitle || "another session",
        } });
      } else if (err.error === "model_required") {
        store.setDraft(text);
        this.ta.value = text;
        this.attachments = images;
        this.renderAttachments();
        store.setError("No model is available. Connect a provider or choose one in Settings.");
      } else {
        store.setDraft(text);
        this.ta.value = text;
        this.attachments = images;
        this.renderAttachments();
        store.setError(`Send failed: ${err.error || err.message || err}`);
      }
    }
  }

  sync() {
    const id = store.activeKey();
    const t = store.transcript();
    const p = store.project();
    const lock = store.workspaceBusy(id);
    const compacting = !!t.compacting;
    this.ta.placeholder = store.inProject() && p ? `Ask about ${p.name}…` : "Send a message…";
    const activeId = store.activeKey();
    const draft = store.draft(activeId);
    if (activeId !== this.draftSessionId || (this.ta.value !== draft && document.activeElement !== this.ta)) this.ta.value = draft;
    this.draftSessionId = activeId;
    if (activeId !== this.commandSessionId) {
      this.commandSessionId = null;
      this.commands = [];
      this.allCommands = [];
      this.closeCommands();
    }
    if (this.commandQuery() !== null && activeId) void this.syncCommands();
    else this.renderCommands();
    const error = store.state.error;
    const nQueued = store.state.queued[id] || 0;
    this.ta.classList.toggle("busy", t.streaming || compacting || !!lock);
    this.ta.classList.toggle("error", !!error);
    this.ta.placeholder = error || (compacting
      ? "Compacting context…"
      : t.streaming ? "Enter a steering message, alt+enter a follow-up…"
        : lock ? "Another session is streaming — open it to send a steering message…"
          : store.inProject() && p ? `Ask about ${p.name}…` : "Send a message…");
    this.stopBtn.classList.toggle("hidden", !t.streaming);
    // Keep Send available during a turn so it can steer or queue a follow-up.
    this.sendBtn.disabled = compacting || !!lock;
  }
}

customElements.define("pi-thread", PiThread);
customElements.define("pi-model-picker", PiModelPicker);
customElements.define("pi-context-meter", PiContextMeter);
customElements.define("pi-thinking-picker", PiThinkingPicker);
customElements.define("pi-composer", PiComposer);
