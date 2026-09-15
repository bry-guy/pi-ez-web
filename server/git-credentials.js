import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("./git-credential-helper.js", import.meta.url));

export function gitCredentialEnvironment(source = process.env) {
  return {
    ...source,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: helperPath,
    GIT_ASKPASS_REQUIRE: "force",
  };
}
