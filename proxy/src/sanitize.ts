// Everything that turns external data into text for an agent goes through here.
// See THREAT_MODEL.md, T1.

export const MAX_TEXT_CHARS = 280;
const IDENTIFIER = /^[A-Za-z0-9._/#:@+-]{1,100}$/;
const META_KEY = /^[A-Za-z0-9_]{1,40}$/;

// Allowlist approach: after NFKC, keep only letters, marks, numbers, punctuation,
// symbols and plain spaces. This drops every control, format (Cf: zero-width,
// bidi, soft hyphen, Tag characters U+E0000–E007F used for "ASCII smuggling"),
// private-use, unassigned and surrogate code point, plus line/paragraph
// separators. Variation selectors and Hangul fillers are dropped explicitly
// because they are categorized as marks/letters but render invisibly.
const LINE_BREAKS = /[\r\n\t\u0085\u2028\u2029]+/g;
const NOT_ALLOWED = /[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu;
const INVISIBLE_ALLOWED = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0\u180B-\u180F]/gu;

/** For values that must be identifiers (ids, statuses, branch names). */
export function identifier(value: string): string {
  return IDENTIFIER.test(value) ? value : "<redacted:invalid>";
}

/** For any structured scalar shown to the agent. */
export function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return identifier(value);
  return "<redacted:invalid>";
}

/** For untrusted free text. Never contains markup that could open/close tags. */
export function untrustedText(value: string, maxChars = MAX_TEXT_CHARS): string {
  let s = value.normalize("NFKC").replace(LINE_BREAKS, " ");
  s = s.replace(NOT_ALLOWED, "").replace(INVISIBLE_ALLOWED, "");
  s = s.replace(/ {2,}/g, " ").trim();
  // Neutralize anything tag-like, and every quote character, so the text can
  // neither open/close tags nor close the “…” envelope it is rendered in.
  s = s.replace(/</g, "‹").replace(/>/g, "›").replace(/["\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, "'").replace(/`/g, "'");
  const chars = Array.from(s);
  if (chars.length > maxChars) s = chars.slice(0, maxChars).join("") + "…";
  return s;
}

/** Channel meta keys must be identifiers or Claude Code drops them silently. */
export function metaKey(key: string): string | null {
  return META_KEY.test(key) ? key : null;
}
