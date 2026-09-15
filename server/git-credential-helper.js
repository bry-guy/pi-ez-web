#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function storedToken() {
  const authPath = path.join(process.env.PI_WEB_HOME || path.join(process.env.HOME || ".", ".pi-web-ui"), "github-auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return auth?.accessToken || null;
  } catch {
    return null;
  }
}

function effectiveToken() {
  return process.env.PI_WEB_GITHUB_TOKEN || storedToken();
}

const protocolOperation = new Set(["get", "store", "erase"]);
if (process.argv[2] && !protocolOperation.has(process.argv[2])) {
  const prompt = process.argv.slice(2).join(" ");
  if (/username/i.test(prompt)) process.stdout.write("x-access-token\n");
  else if (/password/i.test(prompt)) {
    const token = effectiveToken();
    if (token) process.stdout.write(`${token}\n`);
  }
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const values = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  if (values.protocol !== "https" || values.host?.toLowerCase() !== "github.com") return;
  const token = effectiveToken();
  if (!token) return;
  process.stdout.write(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`);
});
