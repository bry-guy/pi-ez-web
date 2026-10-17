import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { compareTreeNodes, defaultBranch, fileTree } from "./workspaces.js";

hljs.registerLanguage("dockerfile", dockerfile);

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_HIGHLIGHT_BYTES = 512 * 1024;
export const DEFAULT_DIFF_TARGET = "origin";
const DIFF_TARGETS = ["origin", "primary"];

const LANGUAGE_BY_EXTENSION = {
  bash: "bash", sh: "bash", zsh: "bash",
  c: "c", cc: "cpp", cpp: "cpp", h: "c", hh: "cpp", hpp: "cpp",
  css: "css", go: "go", html: "xml", htm: "xml", java: "java",
  js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json", md: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", rs: "rust", scss: "scss", sql: "sql",
  ts: "typescript", mts: "typescript", tsx: "typescript", xml: "xml",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
};

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativePath(raw) {
  const value = String(raw || "");
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw coded("invalid_file_path");
  }
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part === ".git" || part === "node_modules")) {
    throw coded("invalid_file_path");
  }
  return parts.join("/");
}

function resolveFile(workspace, rawPath) {
  const relative = relativePath(rawPath);
  let root;
  let absolute;
  try {
    root = fs.realpathSync(workspace);
    absolute = path.resolve(root, ...relative.split("/"));
  } catch {
    throw coded("file_not_found");
  }
  if (!inside(root, absolute)) throw coded("invalid_file_path");

  let stat;
  try { stat = fs.lstatSync(absolute); } catch { throw coded("file_not_found"); }
  if (stat.isSymbolicLink()) throw coded("invalid_file_path", "Symbolic links are not previewed.");
  if (stat.isDirectory()) throw coded("file_is_directory");
  if (!stat.isFile()) throw coded("file_unsupported", "Only regular files are previewed.");

  let real;
  try { real = fs.realpathSync(absolute); } catch { throw coded("file_not_found"); }
  if (!inside(root, real)) throw coded("invalid_file_path");
  return { absolute: real, relative };
}

function languageFor(relative) {
  const name = path.posix.basename(relative).toLowerCase();
  const extension = path.posix.extname(name).slice(1);
  const language = name === "dockerfile" || name.startsWith("dockerfile.") ? "dockerfile" : LANGUAGE_BY_EXTENSION[extension];
  return language && hljs.getLanguage(language) ? language : null;
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.fallback !== undefined) return options.fallback;
    throw coded("git_failed", error?.stderr?.trim() || error?.message || "Git operation failed.");
  }
}

// Commit the working tree is diffed against; null when there is no history to compare.
function diffBase(workspace, repoPath, target) {
  const primary = defaultBranch(repoPath);
  const mergeBase = () => {
    for (const ref of [`origin/${primary}`, primary]) {
      const base = git(workspace, ["merge-base", "HEAD", ref], { fallback: "" }).trim();
      if (base) return base;
    }
    return null;
  };
  if (target === "primary") {
    const base = mergeBase();
    return base ? { base, label: `vs ${primary}` } : null;
  }
  const upstream = git(workspace, ["rev-parse", "--verify", "-q", "@{upstream}"], { fallback: "" }).trim();
  if (upstream) return { base: upstream, label: "vs origin" };
  const base = mergeBase();
  return base ? { base, label: `vs ${primary} (no upstream)` } : null;
}

function visiblePath(relative) {
  const parts = String(relative || "").split("/");
  return parts.length > 0 && parts.every(part => part && part !== ".git" && part !== "node_modules");
}

function statusKind(code) {
  return code === "A" ? "new" : code === "D" ? "removed" : "modified";
}

function workingTreeStatuses(workspace) {
  const statuses = new Map();
  const output = git(workspace, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--"], { fallback: "" });
  for (const record of output.split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const relative = record.slice(3);
    if (!visiblePath(relative)) continue;
    const status = code.includes("D") ? "removed" : code.includes("A") || code.includes("?") ? "new" : "modified";
    statuses.set(relative, status);
  }
  return statuses;
}

function diffStatuses({ workspace, base }) {
  if (!base) return workingTreeStatuses(workspace);
  const statuses = new Map();
  const diff = git(workspace, ["diff", "--no-ext-diff", "--no-color", "--name-status", "--no-renames", "-z", base, "--"], { fallback: "" });
  const fields = diff.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i];
    const relative = fields[i + 1];
    if (code && visiblePath(relative)) statuses.set(relative, statusKind(code[0]));
  }

  // `git diff <base>` includes tracked changes, but not untracked files.
  for (const [relative, status] of workingTreeStatuses(workspace)) {
    if (status === "new" && !statuses.has(relative)) statuses.set(relative, status);
  }
  return statuses;
}

function addStatusPath(nodes, relative, status) {
  const parts = relative.split("/");
  let current = nodes;
  let prefix = "";
  for (let i = 0; i < parts.length; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    let node = current.find(item => item.p === prefix);
    if (!node) {
      node = { n: parts[i], p: prefix };
      if (i < parts.length - 1) node.c = [];
      current.push(node);
    }
    if (i === parts.length - 1) node.s = status;
    current = node.c || [];
  }
}

function sortStatusTree(nodes) {
  for (const node of nodes) {
    if (!Array.isArray(node.c)) continue;
    sortStatusTree(node.c);
    const kinds = new Set(node.c.map(child => child.s));
    node.s = kinds.size === 1 ? [...kinds][0] : "modified";
  }
  return nodes.sort(compareTreeNodes);
}

function statusTree(statuses, tree = []) {
  for (const [relative, status] of statuses) addStatusPath(tree, relative, status);
  return sortStatusTree(tree);
}

function checkTarget(target) {
  if (!DIFF_TARGETS.includes(target)) throw coded("invalid_diff_target", `Diff target ${target} is unavailable.`);
}

export function readFileTree({ workspace, repoPath, target = DEFAULT_DIFF_TARGET }) {
  checkTarget(target);
  const statuses = diffStatuses({ workspace, base: diffBase(workspace, repoPath, target)?.base });
  return { tree: statusTree(statuses, fileTree(workspace)), target, targets: DIFF_TARGETS };
}

function contentLines(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function untrackedDiff(content, target, binary = false) {
  if (binary) return { target, adds: 0, dels: 0, lines: [], binary: true, changed: true };
  const lines = contentLines(content).map(text => ({ sign: "+", text }));
  return {
    target,
    adds: lines.length,
    dels: 0,
    lines: [{ sign: "", hunk: true, text: `@@ -0,0 +1,${lines.length} @@` }, ...lines],
    binary: false,
    changed: true,
  };
}

// Each diff line keeps its old/new line number so it can borrow that line's highlighting.
function parsePatch(patch, target) {
  const source = patch.split(/\r?\n/);
  if (source.at(-1) === "") source.pop();
  const lines = [];
  let inHunk = false;
  let adds = 0;
  let dels = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const line of source) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ sign: "", hunk: true, text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) { adds++; lines.push({ sign: "+", text: line.slice(1), newNo: newNo++ }); }
    else if (line.startsWith("-")) { dels++; lines.push({ sign: "-", text: line.slice(1), oldNo: oldNo++ }); }
    else if (line.startsWith(" ")) lines.push({ sign: " ", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith("\\")) lines.push({ sign: "", text: line });
  }
  return { target, adds, dels, lines, binary: /Binary files/.test(patch), changed: !!patch };
}

function highlight(content, language) {
  if (!language || content == null || Buffer.byteLength(content) > MAX_HIGHLIGHT_BYTES) return null;
  try { return hljs.highlight(content.replace(/\r\n/g, "\n"), { language }).value; } catch { return null; }
}

// highlight.js spans can cross lines (block comments, template strings); close
// them at each line end and reopen them on the next line so lines stand alone.
export function highlightedLines(html) {
  if (html == null) return null;
  const lines = [];
  const open = [];
  let line = "";
  for (const [, start, end, newline, text] of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (start) { open.push(start); line += start; }
    else if (end) { open.pop(); line += end; }
    else if (newline) { lines.push(line + "</span>".repeat(open.length)); line = open.join(""); }
    else line += text;
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'", "&#39;": "'" };
const plainText = html => html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => ENTITIES[entity]);

// Attach highlighted HTML to diff lines; a line whose text does not match is left plain.
function highlightDiff(lines, oldLines, newLines) {
  for (const line of lines) {
    if (line.hunk) continue;
    const source = line.sign === "-" ? oldLines?.[line.oldNo - 1] : line.newNo ? newLines?.[line.newNo - 1] : null;
    if (source != null && plainText(source) === line.text) line.html = source;
    delete line.oldNo;
    delete line.newNo;
  }
  return lines;
}

function diffForFile({ workspace, relative, content, binary, target, base, language = null, highlighted = null }) {
  const label = base?.label || "working tree";
  const status = git(workspace, ["status", "--porcelain=v1", "--", relative], { fallback: "" });
  if (status.split("\n").some(line => line.startsWith("?? "))) {
    const diff = untrackedDiff(content, target, binary);
    const newLines = highlightedLines(highlighted);
    if (newLines) diff.lines.forEach((line, index) => { if (index > 0 && plainText(newLines[index - 1] ?? "") === line.text) line.html = newLines[index - 1]; });
    return { ...diff, label };
  }
  if (!base) return null;
  const patch = git(workspace, ["diff", "--no-ext-diff", "--no-color", "--unified=3", base.base, "--", relative]);
  const diff = parsePatch(patch, target);
  if (language && diff.lines.length) {
    const previous = git(workspace, ["show", `${base.base}:${relative}`], { fallback: null, maxBuffer: MAX_FILE_BYTES * 2 });
    highlightDiff(diff.lines, highlightedLines(highlight(previous, language)), highlightedLines(highlighted));
  } else highlightDiff(diff.lines, null, null);
  return { ...diff, label };
}

export function readFileView({ workspace, repoPath, path: rawPath, target = DEFAULT_DIFF_TARGET }) {
  const file = resolveFile(workspace, rawPath);
  let bytes;
  try { bytes = fs.readFileSync(file.absolute); } catch { throw coded("file_not_found"); }
  if (bytes.length > MAX_FILE_BYTES) throw coded("file_too_large", "Files larger than 1 MiB are not previewed.");
  const size = bytes.length;
  const binary = bytes.includes(0);
  checkTarget(target);
  const base = diffBase(workspace, repoPath, target);
  if (binary) {
    return {
      path: file.relative, size, binary: true, content: null, highlighted: null,
      language: null, target, targets: DIFF_TARGETS,
      diff: diffForFile({ workspace, relative: file.relative, content: null, binary, target, base }),
    };
  }

  const content = bytes.toString("utf8");
  const language = languageFor(file.relative);
  const highlighted = highlight(content, language);
  return {
    path: file.relative, size, binary: false, content, highlighted, language, target, targets: DIFF_TARGETS,
    diff: diffForFile({ workspace, relative: file.relative, content, binary: false, target, base, language, highlighted }),
  };
}
