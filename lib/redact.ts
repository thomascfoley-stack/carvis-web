/**
 * Secret scrubber.
 *
 * Every error string in this app can end up somewhere public: `/login?error=`
 * puts it in the address bar and browser history, the chat stream sends it to
 * the browser, and the failures table persists it. Upstream services routinely
 * echo the offending credential back ("Invalid API key: sk-…owAA"), and a
 * Postgres DSN carries its password inline.
 *
 * So nothing reaches a user-visible surface without passing through here.
 * Deliberately aggressive: over-redacting an error message costs a little
 * debuggability, under-redacting one costs a credential.
 */

const RULES: [RegExp, string][] = [
  // Connection strings carry the password inline: postgres://user:pass@host/db
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^@\s]+@/gi, "$1[redacted]@"],

  // Vendor-prefixed keys: sk-…, ak_…, pk_…, xi-…, gsk_…, r8_…
  [/\b(sk|ak|pk|rk|sq|gsk|xi|r8|key|tok|secret)[-_][A-Za-z0-9_\-*.]{4,}/gi, "$1_[redacted]"],

  // JWTs / ID tokens.
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.?[A-Za-z0-9_\-]*/g, "[redacted-jwt]"],

  // "Bearer <token>" / "Token <token>" — must run before the header rule,
  // which otherwise consumes the word "Bearer" as the value and leaves the
  // actual token standing.
  [/\b(bearer|token)\s+[A-Za-z0-9_\-.+/=]{6,}/gi, "$1 [redacted]"],

  // Header-ish and field-ish assignments.
  [/(authorization|bearer|x-api-key|api[-_]?key|password|token|secret)\s*[:=]?\s*["']?[A-Za-z0-9_\-.+/=]{6,}["']?/gi, "$1 [redacted]"],

  // Anything long and opaque enough to be a credential.
  [/\b[A-Za-z0-9_\-]{40,}\b/g, "[redacted]"],
];

export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  for (const [pattern, replacement] of RULES) s = s.replace(pattern, replacement);
  return s;
}

/**
 * For anything that lands in a URL. Redacts, then hard-caps the length so a
 * stack trace can't be smuggled into a query string either.
 */
export function safeMessage(input: unknown, max = 160): string {
  return redact(input).replace(/\s+/g, " ").trim().slice(0, max);
}
