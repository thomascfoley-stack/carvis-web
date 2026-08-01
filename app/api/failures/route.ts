import { isAdmin, sessionFromRequest } from "@/lib/auth";
import { FAILURE_STATUSES, dbEnabled, listFailures, setFailureStatus } from "@/lib/db";
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
