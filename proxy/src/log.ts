// stderr-only logger with secret redaction. stdout carries the MCP protocol,
// so nothing may ever be written there. See THREAT_MODEL.md, T3.

const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic / OAuth / app tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic keys
  /(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, // auth headers
  /sha256=[0-9a-f]{64}/g, // webhook signatures
];

const extraSecrets = new Set<string>();

/** Register a runtime secret (e.g. the webhook secret) so it is never logged. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

export function redact(input: string): string {
  let s = input;
  for (const secret of extraSecrets) s = s.split(secret).join("[REDACTED]");
  for (const p of PATTERNS) s = s.replace(p, "[REDACTED]");
  return s;
}

export function log(msg: string): void {
  process.stderr.write(`[heedwise] ${redact(msg)}\n`);
}
