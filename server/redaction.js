const SECRET_ENV_NAMES = ["OP_SERVICE_ACCOUNT_TOKEN", "PI_WEB_GITHUB_TOKEN"];

export function redact(value, { maxLength = Infinity, secrets = process.env } = {}) {
  let text = String(value ?? "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/ops_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
  for (const name of SECRET_ENV_NAMES) {
    const secret = secrets?.[name];
    if (secret) text = text.split(String(secret)).join("[redacted]");
  }
  return text.slice(0, maxLength);
}
