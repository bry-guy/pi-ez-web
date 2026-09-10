import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWrite(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, mode); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
