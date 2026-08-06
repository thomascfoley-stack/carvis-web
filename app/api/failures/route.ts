import { isAdmin, sessionFromRequest } from "@/lib/auth";
import { FAILURE_STATUSES, dbEnabled, listFailures, recordFailure, setFailureStatus } from "@/lib/db";
import { redact } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The fixer agent's window into the failures table.
 *
 * Vercel marks every env var on this project Sensitive — write-only — so
 * nothing outside the deployment can ever hold the database URL. The daily
 * fixer therefore reads its queue through this route with an admin's own
 * signed-in session, and holds no credential of any kind.
 *
 * Gated twice: a valid session, and membership in CARVIS_ADMIN_EMAILS. Both
 * misses answer 404, not 403 — a probe learns nothing, not even that the
 * route exists. Everything served here was redacted at write time.
 */
async function admin(req: Request): Promise<boolean> {
  const session = await sessionFromRequest(req);
  return !!session && isAdmin(session.email);
}

export async function GET(req: Request) {
  if (!(await admin(req))) return new Response("Not found", { status: 404 });

  const status = new URL(req.url).searchParams.get("status") === "all" ? "all" : "open";
  try {
    return Response.json({ db: dbEnabled(), failures: await listFailures(status) });
  } catch (e) {
    // Even here, redact: a driver's connection-string error quotes the DSN.
    return Response.json({ error: redact(e).slice(0, 200) }, { status: 500 });
  }
}

/**
 * The browser half of the failures table.
 *
 * Everything the client can see and the server cannot — the recogniser losing
 * its connection, audio refusing to start, an uncaught render error — lands in
 * the same bucket as backend defects, so one query answers "what is broken".
 *
 * Any signed-in user may post: these are reports about OUR software failing
 * them, and requiring admin would mean only ever hearing about the operator's
 * own problems. That makes this the one write path a tenant can influence, so
 * it is bounded hard: the node name is drawn from a fixed allowlist prefix,
 * the message is capped and redacted, and the same noise discipline applies as
 * everywhere else — a user's own denied microphone is their configuration, not
 * our defect, and is not worth a row.
 */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return new Response("Not found", { status: 404 });
  if (!dbEnabled()) return Response.json({ ok: true });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const node = String(body?.node ?? "").trim().slice(0, 64);
  const message = String(body?.message ?? "").trim().slice(0, 400);
  if (!node || !message) return new Response("Bad request", { status: 400 });

  // Only names this app actually emits. Without this the fingerprint space is
  // attacker-controlled and one tenant could shred the table's usefulness.
  if (!/^(client|voice|speaker|orb)\./.test(node)) {
    return Response.json({ ok: true, ignored: "unknown node" });
  }

  // Configuration, not defects — the same exclusions the server side applies.
  if (/not-allowed|service-not-allowed|permission|denied|\b40[13]\b/i.test(message)) {
    return Response.json({ ok: true, ignored: "user configuration" });
  }

  await recordFailure({
    node: `client.${node}`.replace(/^client\.client\./, "client."),
    errorClass: "ClientFailure",
    message: redact(message),
    // Shape only, and only what helps reproduce: never the user's words.
    input: { ua: redact(String(body?.ua ?? "")).slice(0, 160) },
  });
  return Response.json({ ok: true });
}

/** Status transitions only — rows are born from recordFailure, never from here. */
export async function PATCH(req: Request) {
  if (!(await admin(req))) return new Response("Not found", { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const fingerprint = String(body?.fingerprint ?? "");
  const status = String(body?.status ?? "");
  if (!fingerprint || !(FAILURE_STATUSES as readonly string[]).includes(status)) {
    return Response.json({ error: `status must be one of ${FAILURE_STATUSES.join(", ")}` }, { status: 400 });
  }

  try {
    return Response.json({ updated: await setFailureStatus(fingerprint, status) });
  } catch (e) {
    return Response.json({ error: redact(e).slice(0, 200) }, { status: 500 });
  }
}
