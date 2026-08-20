export const API_CONTRACT_VERSION = 2;
export const API_CAPABILITIES = Object.freeze([
  "provider-auth",
  "github-device-auth",
  "repository-sources",
  "session-activity",
  "slash-commands",
  "project-hooks",
  "pi-resources",
  "extension-activity",
  "file-explorer",
]);
export const BUILD_ID = process.env.PI_WEB_BUILD_ID || "development";
