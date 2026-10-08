export function parseWorktreeRecords(stdout) {
  const records = [];
  let record = null;
  const finish = () => {
    if (!record) return;
    records.push(record);
    record = null;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      finish();
      record = { path: line.slice(9).trim(), head: null, branch: null, detached: false };
    } else if (!record) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      record.head = line.slice(5).trim() || null;
    } else if (line.startsWith("branch ")) {
      record.branch = line.slice(7).trim().replace(/^refs\/heads\//, "") || null;
    } else if (line === "detached") {
      record.detached = true;
    }
  }
  finish();
  return records;
}

export function parseStatusV2(stdout) {
  const result = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, details: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 } };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) { const oid = line.slice(13).trim(); result.head = oid === "(initial)" ? null : oid; continue; }
    if (line.startsWith("# branch.head ")) { const head = line.slice(14).trim(); result.branch = head === "(detached)" ? null : head; continue; }
    if (line.startsWith("# branch.upstream ")) { result.upstream = line.slice(18).trim() || null; continue; }
    if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice(12).trim().split(/\s+/).map(n => Math.abs(Number(n)));
      result.ahead = Number.isFinite(ahead) ? ahead : 0;
      result.behind = Number.isFinite(behind) ? behind : 0;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("! ")) continue;
    const d = result.details;
    d.total++;
    if (line.startsWith("? ")) { d.untracked++; continue; }
    if (line.startsWith("u ")) { d.conflicts++; continue; }
    const code = line.slice(2, 4);
    if (code[0] !== ".") d.staged++;
    if (code[1] !== ".") d.unstaged++;
  }
  return result;
}
