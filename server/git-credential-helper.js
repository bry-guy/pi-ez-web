#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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
  const authPath = path.join(process.env.PI_WEB_HOME || path.join(process.env.HOME || ".", ".pi-web-ui"), "github-auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!auth?.accessToken) return;
    process.stdout.write(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${auth.accessToken}\n\n`);
  } catch {
    // Git should continue without credentials when the web login is absent.
  }
});
