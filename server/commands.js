// Commands the web UI can execute without a terminal-only interaction layer.
// Pi's interactive built-ins are not all meaningful in a browser, so this list
// contains the stable web-supported subset. Extension commands, prompt
// templates, and skills are added from the attached Pi session below.
export const WEB_PI_COMMANDS = Object.freeze([
  { name: "settings", description: "Open settings", source: "pi" },
  { name: "name", description: "Set the session display name", source: "pi" },
]);

export function parseSlashCommand(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] || "", text: value };
}

function addCommand(result, seen, name, description, source) {
  if (!name || seen.has(name)) return;
  seen.add(name);
  result.push({
    name: String(name),
    ...(description ? { description: String(description) } : {}),
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
    );
  }
  for (const prompt of prompts || []) addCommand(result, seen, prompt.name, prompt.description, "prompt");
  for (const skill of skills || []) {
    if (skill.disableModelInvocation) continue;
    addCommand(result, seen, `skill:${skill.name}`, skill.description, "skill");
  }
  return result;
}
