import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("./git-credential-helper.js", import.meta.url));
const URL_HELPER_KEY = "credential.https://github.com.helper";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function inheritedConfig(source) {
  const rawCount = source.GIT_CONFIG_COUNT;
  if (rawCount === undefined) return [];
  if (!/^(?:0|[1-9]\d*)$/.test(String(rawCount))) {
    throw Object.assign(new Error("Invalid inherited Git configuration."), { code: "invalid_git_configuration" });
  }
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count)) {
    throw Object.assign(new Error("Invalid inherited Git configuration."), { code: "invalid_git_configuration" });
  }
  const entries = [];
  for (let index = 0; index < count; index++) {
    const key = source[`GIT_CONFIG_KEY_${index}`];
    const value = source[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== "string" || !key || typeof value !== "string") {
      throw Object.assign(new Error("Invalid inherited Git configuration."), { code: "invalid_git_configuration" });
    }
    entries.push([key, value]);
  }
  return entries;
}

export function gitCredentialEnvironment(source = process.env) {
  const entries = inheritedConfig(source);
  const helper = `!${shellQuote(process.execPath)} ${shellQuote(helperPath)}`;
  const environment = { ...source, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(entries.length + 2) };
  delete environment.GIT_ASKPASS;
  delete environment.GIT_ASKPASS_REQUIRE;
  entries.concat([[URL_HELPER_KEY, ""], [URL_HELPER_KEY, helper]]).forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
