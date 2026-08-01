import {
  STATE_COOKIE,
  clearState,
  createSession,
  domainAllowed,
  isAllowed,
  readCookie,
  readState,
  sessionCookie,
} from "@/lib/auth";
import { getConnection, gmailAddress } from "@/lib/composio";
import { findUser, upsertUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(origin: string, message: string): Response {
  const url = new URL("/login", origin);
  url.searchParams.set("error", message.slice(0, 200));
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "set-cookie": clearState() },
  });
}

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  // 1. The flow must be one this server started, and carries the Composio id.
  const state = await readState(readCookie(req, STATE_COOKIE));
  if (!state) return fail(origin, "Sign-in link expired. Please try again.");

  // 2. Composio must actually hold the connection now.
  const conn = await getConnection(state.caid);
  if (!conn.ok) return fail(origin, `Could not verify the connection: ${conn.error}`);
  if (conn.data.status && !["ACTIVE", "INITIATED"].includes(conn.data.status)) {
    return fail(origin, `Google authorisation did not complete (${conn.data.status}).`);
  }

  // 3. Identity comes from the Gmail profile behind *this session's* id.
  const email = await gmailAddress(state.cid);
  if (!email) {
    return fail(origin, "Connected, but Gmail did not return a profile. Try again.");
  }
  if (!domainAllowed(email)) {
    return fail(origin, `${email} is not on an allowed domain for this instance.`);
  }
  if (!isAllowed(email)) {
    return fail(origin, `${email} is not on the allowlist for this instance.`);
  }

  // 4. Returning users keep their original Composio id so connections and
  //    memory follow them; new users keep the one we minted at /start.
  let composioUserId = state.cid;
  try {
    const existing = await findUser(email);
    composioUserId = existing?.composio_user_id ?? state.cid;
    await upsertUser(email, composioUserId);
  } catch (e) {
    return fail(origin, `Could not reach the database: ${String(e).slice(0, 120)}`);
  }

  const headers = new Headers({ location: new URL("/", origin).toString() });
  headers.append("set-cookie", sessionCookie(await createSession(email, composioUserId)));
  headers.append("set-cookie", clearState());

  return new Response(null, { status: 302, headers });
}
