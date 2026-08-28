export const API_CONTRACT_VERSION = 5;
export const API_CAPABILITIES = Object.freeze([
  "provider-auth",
  "github-device-auth",
  "repository-sources",
  "session-activity",
  "slash-commands",
  "project-hooks",
  "workspace-contexts",
  "workspace-branches",
  "pi-resources",
  "extension-activity",
  "extension-ui",
  "subagent-activity",
  "file-explorer",
  "pi-sync",
]);
export const BUILD_ID = process.env.PI_WEB_BUILD_ID || "development";
