import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../public/", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");

test("PWA manifest describes an installable standalone app", async () => {
  const manifest = JSON.parse(await read("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.ok(manifest.icons.some(icon => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "maskable"));
  for (const icon of manifest.icons) await access(new URL(icon.src.slice(1), root));
  await access(new URL("icons/apple-touch-icon.png", root));
});

test("HTML includes iOS and web app metadata", async () => {
  const html = await read("index.html");
  assert.match(html, /rel="manifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /viewport-fit=cover/);
});

test("service worker caches only the app shell and bypasses API traffic", async () => {
  const worker = await read("sw.js");
  assert.match(worker, /addEventListener\("install"/);
  assert.match(worker, /addEventListener\("fetch"/);
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.doesNotMatch(worker, /cache\.put\(request, response\.clone\(\)\).*api/);
});

test("service worker precaches the complete local frontend module graph", async () => {
  const worker = await read("sw.js");
  const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const cached = new Set([...shell.matchAll(/"([^"]+)"/g)].map(match => match[1]));
  const pending = [new URL("js/main.js", root)];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file.href)) continue;
    seen.add(file.href);
    assert.ok(cached.has(`/${file.pathname.slice(root.pathname.length)}`), `${file.href} is missing from the shell cache`);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      if (match[1].startsWith(".")) pending.push(new URL(match[1], file));
    }
  }
  assert.ok(seen.size > 10);
});
