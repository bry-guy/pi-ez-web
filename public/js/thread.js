import { api, openTranscript, refreshState } from "./api.js";
import { store } from "./store.js";
import { esc, selectSession } from "./shell.js";

const PI_ANIMS = [
  "piImplode 4.6s cubic-bezier(.7,0,.3,1) infinite",
  "piOrbit 4.6s cubic-bezier(.65,0,.35,1) infinite",
  "piBreathe 4.6s ease-in-out infinite",
];

/* ---------------- thread ---------------- */
class PiThread extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => {
      if (w === "state" || w === "transcript") this.render();
      else if (w === "delta:" + store.activeKey()) this.applyDelta();
      else if (w === "anim") this.swapAnim();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async onClick(e) {
    const fork = e.target.closest("[data-fork]");
    if (fork) return this.fork(fork.dataset.fork);
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
      const { id: childId } = await api.fork(id, recordId);
      await refreshState();
      store.state.openTree[id] = true;
      selectSession(store.state.projectId, childId);
      store.set({ draft: rec?.text || "" });
    } catch (err) {
      console.warn("fork failed", err);
    }
  }

  isOpen(id) { return store.state.openTools[id] ?? false; }

  applyDelta() {
    const holder = this.querySelector("[data-live-text]");
    const recs = store.transcript().records;
    const last = [...recs].reverse().find(r => r.role === "assistant" && r.streaming);
    if (!holder || !last) return this.render();
    holder.childNodes[0].nodeValue = last.text;
    const think = this.querySelector(".pi-think");
    if (think && last.text) this.render(); // thinking -> streaming transition
    this.autoscroll();
  }

  swapAnim() {
    const el = this.querySelector(".pi-think span");
    if (el) el.style.animation = PI_ANIMS[store.state.animIdx % PI_ANIMS.length];
  }

  autoscroll() {
    const sc = this.closest(".scrollable") || this;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
  }

  render() {
    const t = store.transcript();
    const noFork = !!store.state.chatId;
    if (!store.activeKey()) { this.innerHTML = ""; return; }
    if (t.records.length === 0) {
      this.innerHTML = `<div class="empty-pi"><div class="tile">π</div></div>`;
      return;
    }
    this.innerHTML = t.records.map(m => this.renderRecord(m, noFork)).join("");
    this.autoscroll();
  }

  renderRecord(m, noFork) {
    if (m.role === "user") {
      return `<div class="msg ${noFork ? "no-fork" : ""}">
        <div class="msg-user-row">
          <button class="fork-btn" data-fork="${esc(m.id)}" title="Fork">
            <span class="sigil">⑂</span><span class="word">fork</span>
          </button>
          <div class="bubble">${esc(m.text)}</div>
        </div></div>`;
    }
    if (m.role === "assistant") {
      const thinking = m.streaming && !m.text;
      const caret = m.streaming && m.text;
      if (thinking) {
        return `<div class="msg"><div class="pi-think"><span style="animation:${PI_ANIMS[store.state.animIdx % PI_ANIMS.length]}">π</span></div></div>`;
      }
      return `<div class="msg"><div class="assist" ${m.streaming ? "data-live-text" : ""}>${esc(m.text)}${caret ? `<span class="caret-bar"></span>` : ""}</div></div>`;
    }
    if (m.role === "tool") {
      const open = this.isOpen(m.id);
      return `<div class="msg"><div class="block">
        <div class="block-head" data-toggle="${esc(m.id)}">
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
      const lines = (m.lines || []).map(l => {
        const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : l.sign === "" ? "hunk" : "";
        return `<div class="diff-line ${cls}"><span class="sign">${esc(l.sign)}</span>${esc(l.text)}</div>`;
      }).join("");
      return `<div class="msg"><div class="block">
        <div class="block-head" data-toggle="${esc(m.id)}">
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

/* ---------------- composer ---------------- */
class PiComposer extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="composer-outer"><div class="composer-pad"><div class="composer">
      <textarea rows="2"></textarea>
      <div class="composer-foot">
        <div class="composer-hint"></div>
        <button class="model-chip" title="Switch model"></button>
        <button class="stop-btn hidden"><span class="sq"></span>Stop</button>
        <button class="send-btn" title="Send">↑</button>
      </div>
    </div></div></div>`;
    this.ta = this.querySelector("textarea");
    this.hint = this.querySelector(".composer-hint");
    this.chip = this.querySelector(".model-chip");
    this.stopBtn = this.querySelector(".stop-btn");
    this.sendBtn = this.querySelector(".send-btn");

    this.ta.addEventListener("input", () => { store.state.draft = this.ta.value; });
    this.ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(e.altKey ? "followUp" : undefined);
      }
    });
    this.sendBtn.addEventListener("click", () => this.send());
    this.stopBtn.addEventListener("click", () => api.stop(store.activeKey()));
    this.chip.addEventListener("click", () => this.cycleModel());

    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.sync(); });
    this.sync();
  }
  disconnectedCallback() { this.unsub?.(); }

  async send(forcedMode) {
    const id = store.activeKey();
    const text = this.ta.value.trim();
    if (!id || !text) return;
    this.ta.value = "";
    store.state.draft = "";
    if (text.startsWith("!")) {
      try { await api.bang(id, text.slice(1).trim()); } catch (err) { console.warn(err); }
      return;
    }
    const streaming = store.transcript(id).streaming;
    const mode = forcedMode || (streaming ? "steer" : "prompt");
    try {
      await api.message(id, text, mode);
      delete store.state.busy[id];
    } catch (err) {
      if (err.error === "workspace_busy") { store.state.busy[id] = err.bySessionId; store.notify("transcript"); }
      else console.warn(err);
    }
  }

  cycleModel() {
    const list = ["claude-sonnet-4-6", "gpt-5.2-codex", "gemini-3-pro", "kimi-k2-thinking"];
    const cur = store.state.model || list[0];
    const next = list[(list.indexOf(cur) + 1) % list.length];
    store.set({ model: next });
    const id = store.activeKey();
    if (id) api.setModel(id, next).catch(() => {});
  }

  sync() {
    const id = store.activeKey();
    const t = store.transcript();
    const p = store.project();
    const busyBy = store.state.busy[id];
    this.ta.placeholder = store.inProject() && p ? `Ask about ${p.name}…` : "Send a message…";
    if (this.ta.value !== store.state.draft && document.activeElement !== this.ta) this.ta.value = store.state.draft;
    this.hint.classList.toggle("busy", !!busyBy);
    this.hint.textContent = busyBy
      ? `branch busy in another session`
      : t.streaming ? "Enter steers · Alt+Enter queues a follow-up" : "Enter to send · Shift+Enter for a new line";
    this.chip.textContent = store.state.model || "default";
    this.stopBtn.classList.toggle("hidden", !t.streaming);
    this.sendBtn.classList.toggle("hidden", t.streaming);
    this.sendBtn.disabled = !!busyBy;
  }
}

customElements.define("pi-thread", PiThread);
customElements.define("pi-composer", PiComposer);
