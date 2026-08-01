import {
  STATE_COOKIE,
  clearState,
  createSession,
  isAllowed,
  readState,
  sessionCookie,
} from "@/lib/auth";
import { getConnection, gmailAddress } from "@/lib/composio";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

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

  // 1. The flow must be one we started.
  const state = await readState(readCookie(req, STATE_COOKIE));
  if (!state) return fail(origin, "Sign-in link expired. Please try again.");

  // 2. Composio must actually hold an active connection now.
  const conn = await getConnection(state.caid);
  if (!conn.ok) return fail(origin, `Could not verify the connection: ${conn.error}`);
  if (conn.data.status && !["ACTIVE", "INITIATED"].includes(conn.data.status)) {
    return fail(origin, `Google authorisation did not complete (${conn.data.status}).`);
  }

  // 3. The resulting Google identity must be on the allowlist.
  const email = await gmailAddress();
  if (!email) {
    return fail(origin, "Connected, but Gmail did not return a profile. Check the Gmail scopes.");
  }
  if (!isAllowed(email)) {
    return fail(origin, `${email} is not on the allowlist for this instance.`);
  }

  const headers = new Headers({ location: new URL("/", origin).toString() });
  headers.append("set-cookie", sessionCookie(await createSession(email)));
  headers.append("set-cookie", clearState());

  return new Response(null, { status: 302, headers });
}
