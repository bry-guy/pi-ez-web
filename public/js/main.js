import "./shell.js";
import "./thread.js";
import "./panels.js";
import { connectSSE, openTranscript, refreshState } from "./api.js";
import { store } from "./store.js";
import { selectChat, selectSession } from "./shell.js";

connectSSE();
try {
  await refreshState();
} catch {
  // PiApp renders the fatal restart prompt from store.state.fatalError.
}

// Initial selection: most recent chat, else first project session.
const s = store.state;
if (!s.fatalError && s.chats[0]) selectChat(s.chats[0].id);
else if (!s.fatalError) {
  const p = s.projects[0];
  if (p?.sessions[0]) { store.state.openTree[p.id] = true; selectSession(p.id, p.sessions[0].id); }
  else store.notify("state");
}
