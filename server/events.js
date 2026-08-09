// SSE hub. One stream per tab; all sessions multiplexed; `seq` is for
// client-side ordering/dedupe only (no server replay buffer by design —
// reconnect resumes via transcript snapshot + client-side event buffer).
export const CONTRACT_VERSION = 1;

export class EventHub {
  constructor() {
    this.clients = new Set();
    this.seq = 0;
  }
  emit(sessionId, type, data = {}) {
    const evt = { v: CONTRACT_VERSION, seq: ++this.seq, sessionId, type, ...data };
    const frame = `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const write of this.clients) {
      try { write(frame); } catch { /* client gone; removed on close */ }
    }
    return evt;
  }
  addClient(write) {
    this.clients.add(write);
    write(`: connected v${CONTRACT_VERSION}\n\n`);
    return () => this.clients.delete(write);
  }
}

export const hub = new EventHub();
