const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;

function invalidEnvironment() {
  return Object.assign(new Error("Project environment mapping is invalid."), { code: "invalid_project_environment" });
}

function missingSource() {
  return Object.assign(new Error("Project environment source is missing."), { code: "project_environment_source_missing" });
}

export function normalizeProjectEnvironment(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidEnvironment();
  const entries = Object.entries(value);
  if (entries.some(([destination, source]) => !ENVIRONMENT_NAME.test(destination) || typeof source !== "string" || !ENVIRONMENT_NAME.test(source))) {
    throw invalidEnvironment();
  }
  return Object.fromEntries(entries);
}

export function resolveProjectEnvironment(mapping, source = process.env) {
  const normalized = normalizeProjectEnvironment(mapping);
  if (normalized === undefined) return {};
  return Object.fromEntries(Object.entries(normalized).map(([destination, sourceName]) => {
    const value = source != null && Object.hasOwn(source, sourceName) ? source[sourceName] : undefined;
    if (value === undefined) throw missingSource();
    return [destination, value];
  }));
}
