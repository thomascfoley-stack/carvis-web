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

/**
 * Every quantifier below is bounded.
 *
 * An unbounded run that has to fail — `[^@\s]+@` against text containing no
 * `@` — is retried from every candidate start, which is quadratic in the
 * input length. That matters here because redact() runs on hostile input by
 * definition: upstream error bodies, tool payloads. Measured on the original
 * expression, 72KB of `a://a:` repeats took 397ms and each doubling cost four
 * times as much, so a few hundred KB blocks Node's single thread for tens of
 * seconds — on an instance shared with every other tenant.
 *
 * The caps are far above any real credential, and the catch-all rule at the
 * bottom still redacts anything longer that these might now miss.
 */
const RULES: [RegExp, string][] = [
  // Connection strings carry the password inline: postgres://user:pass@host/db
  [/\b([a-z][a-z0-9+.-]{0,32}:\/\/[^\s:/@]{1,256}:)[^@\s]{1,256}@/gi, "$1[redacted]@"],

  // Vendor-prefixed keys: sk-…, ak_…, pk_…, xi-…, gsk_…, r8_…
  [/\b(sk|ak|pk|rk|sq|gsk|xi|r8|key|tok|secret)[-_][A-Za-z0-9_\-*.]{4,512}/gi, "$1_[redacted]"],

  // JWTs / ID tokens.
  [/\beyJ[A-Za-z0-9_\-]{8,512}\.[A-Za-z0-9_\-]{8,512}\.?[A-Za-z0-9_\-]{0,512}/g, "[redacted-jwt]"],

  // "Bearer <token>" / "Token <token>" — must run before the header rule,
  // which otherwise consumes the word "Bearer" as the value and leaves the
  // actual token standing.
  [/\b(bearer|token)\s{1,8}[A-Za-z0-9_\-.+/=]{6,512}/gi, "$1 [redacted]"],

  // Header-ish and field-ish assignments — including the JSON spelling
  // "password":"…", where a closing quote sits between key and separator.
  [/(authorization|bearer|x-api-key|api[-_]?key|password|token|secret)["']?\s{0,8}[:=]?\s{0,8}["']?[A-Za-z0-9_\-.+/=]{6,512}["']?/gi, "$1 [redacted]"],

  // Anything long and opaque enough to be a credential.
  [/\b[A-Za-z0-9_\-]{40,4096}\b/g, "[redacted]"],
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
