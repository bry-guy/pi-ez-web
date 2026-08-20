import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import hljs from "highlight.js/lib/common";

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_HIGHLIGHT_BYTES = 512 * 1024;

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
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  const extension = path.posix.extname(name).slice(1);
  const language = LANGUAGE_BY_EXTENSION[extension];
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

function hasRef(repoPath, ref) {
  try {
    git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function targetsFor(repoPath) {
  return hasRef(repoPath, "HEAD")
    ? ["HEAD", ...(hasRef(repoPath, "refs/heads/main") ? ["main"] : [])]
    : [];
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

function parsePatch(patch, target) {
  const source = patch.split(/\r?\n/);
  if (source.at(-1) === "") source.pop();
  const lines = [];
  let inHunk = false;
  let adds = 0;
  let dels = 0;
  for (const line of source) {
    if (line.startsWith("@@")) {
      inHunk = true;
      lines.push({ sign: "", hunk: true, text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) { adds++; lines.push({ sign: "+", text: line.slice(1) }); }
    else if (line.startsWith("-")) { dels++; lines.push({ sign: "-", text: line.slice(1) }); }
    else if (line.startsWith(" ")) lines.push({ sign: " ", text: line.slice(1) });
    else if (line.startsWith("\\")) lines.push({ sign: "", text: line });
  }
  return { target, adds, dels, lines, binary: /Binary files/.test(patch), changed: !!patch };
}

function diffForFile({ workspace, repoPath, relative, content, binary, target }) {
  const targets = targetsFor(repoPath);
  if (!targets.includes(target)) throw coded("invalid_diff_target", `Diff target ${target} is unavailable.`);
  const status = git(workspace, ["status", "--porcelain=v1", "--", relative], { fallback: "" });
  if (status.split("\n").some(line => line.startsWith("?? "))) return { ...untrackedDiff(content, target, binary), targets };
  const patch = git(workspace, ["diff", "--no-ext-diff", "--no-color", "--unified=3", target, "--", relative]);
  return { ...parsePatch(patch, target), targets };
}

export function readFileView({ workspace, repoPath, path: rawPath, target = "HEAD" }) {
  const file = resolveFile(workspace, rawPath);
  let bytes;
  try { bytes = fs.readFileSync(file.absolute); } catch { throw coded("file_not_found"); }
  if (bytes.length > MAX_FILE_BYTES) throw coded("file_too_large", "Files larger than 1 MiB are not previewed.");
  const size = bytes.length;
  const binary = bytes.includes(0);
  const targets = targetsFor(repoPath);
  if (!targets.includes(target)) throw coded("invalid_diff_target", `Diff target ${target} is unavailable.`);
  if (binary) {
    return {
      path: file.relative, size, binary: true, content: null, highlighted: null,
      language: null, target, targets,
      diff: diffForFile({ workspace, repoPath, relative: file.relative, content: null, binary, target }),
    };
  }

  const content = bytes.toString("utf8");
  const language = languageFor(file.relative);
  let highlighted = null;
  if (language && size <= MAX_HIGHLIGHT_BYTES) {
    try { highlighted = hljs.highlight(content, { language }).value; } catch { highlighted = null; }
  }
  return {
    path: file.relative, size, binary: false, content, highlighted, language, target, targets,
    diff: diffForFile({ workspace, repoPath, relative: file.relative, content, binary: false, target }),
  };
}

export const fileExplorerLimits = Object.freeze({ maxFileBytes: MAX_FILE_BYTES, maxHighlightBytes: MAX_HIGHLIGHT_BYTES });
