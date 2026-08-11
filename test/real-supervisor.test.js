import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = `
  import { startServer } from './server/index.js';
  const { server } = startServer(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const created = await (await fetch(base + '/api/chats', { method: 'POST' })).json();
  const message = await fetch(base + '/api/sessions/' + created.id + '/message', {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({text:'hello'})
  });
  const transcript = await (await fetch(base + '/api/sessions/' + created.id + '/transcript')).json();
  console.log(JSON.stringify({created, messageStatus: message.status, message: await message.json(), transcript}));
  server.closeAllConnections?.(); server.close();
`;

test("real sessions can be created without provider credentials", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: path.join(tmp, "web"),
        PI_CODING_AGENT_DIR: path.join(tmp, "pi"),
        PI_WEB_MODE: "real",
        PI_WEB_REPOS_ROOT: path.join(tmp, "repos"),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.ok(result.created.id);
    assert.equal(result.messageStatus, 409);
    assert.equal(result.message.error, "model_required");
    assert.deepEqual(result.transcript.records, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
