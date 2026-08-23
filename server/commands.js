// Pi's interactive built-ins are exposed as web actions rather than sent to
// the model. Some terminal-only actions (for example /quit) are adapted to
// the nearest safe browser equivalent by the supervisor and shell.
export const WEB_PI_COMMANDS = Object.freeze([
  { name: "settings", description: "Open settings menu", source: "pi" },
  { name: "model", description: "Select model", argumentHint: "<provider/model>", source: "pi" },
  { name: "scoped-models", description: "Enable or disable models for cycling", source: "pi" },
  { name: "export", description: "Download the session (HTML or JSONL)", argumentHint: "[html|jsonl]", source: "pi" },
  { name: "import", description: "Import a JSONL session file", argumentHint: "<file.jsonl>", source: "pi" },
  { name: "share", description: "Share the session as a private GitHub gist", source: "pi" },
  { name: "copy", description: "Copy the last agent message", source: "pi" },
  { name: "name", description: "Set the session display name", argumentHint: "<name>", source: "pi" },
  { name: "session", description: "Show session info and stats", source: "pi" },
  { name: "changelog", description: "Show changelog entries", source: "pi" },
  { name: "hotkeys", description: "Show browser keyboard shortcuts", source: "pi" },
  { name: "tree", description: "Open the session tree", source: "pi" },
  { name: "trust", description: "Use the server's project trust policy", source: "pi" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>", source: "pi" },
  { name: "logout", description: "Remove provider authentication", source: "pi" },
  { name: "new", description: "Start a new web session", source: "pi" },
  { name: "fork", description: "Fork this session on the same branch", source: "pi" },
  { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]", source: "pi" },
  { name: "resume", description: "Open another session", source: "pi" },
  { name: "reload", description: "Reload extensions, skills, prompts, and resources", source: "pi" },
  { name: "quit", description: "Close the current web session", source: "pi" },
  { name: "debug", description: "Show web diagnostics", source: "pi" },
]);

export function parseSlashCommand(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] || "", text: value };
}

function addCommand(result, seen, name, description, source, argumentHint) {
  if (!name || seen.has(name)) return;
  seen.add(name);
  result.push({
    name: String(name),
    ...(description ? { description: String(description) } : {}),
    ...(argumentHint ? { argumentHint: String(argumentHint) } : {}),
    source,
  });
}

/**
 * Return the browser-visible command surface.
 *
 * `commands` should be the ExtensionRunner's resolved command list. The
 * runner has already assigned invocationName values for duplicate extension
 * registrations (for example, `format:2`), so discovery and execution use
 * exactly the same names.
 */
export function commandInfo({ commands = [], prompts = [], skills = [] } = {}) {
  const result = WEB_PI_COMMANDS.map(command => ({ ...command }));
  const seen = new Set(result.map(command => command.name));

  for (const command of commands || []) {
    addCommand(
      result,
      seen,
      command.invocationName || command.name,
      command.description,
      "extension",
      command.argumentHint,
    );
  }
  for (const prompt of prompts || []) addCommand(result, seen, prompt.name, prompt.description, "prompt", prompt.argumentHint);
  for (const skill of skills || []) {
    if (skill.disableModelInvocation) continue;
    addCommand(result, seen, `skill:${skill.name}`, skill.description, "skill", "[arguments]");
  }
  return result;
}
