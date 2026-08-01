import {
  STATE_COOKIE,
  clearState,
  createSession,
  domainAllowed,
  isAllowed,
  newComposioUserId,
  readCookie,
  readState,
  sessionCookie,
} from "@/lib/auth";
import { findUser, upsertUser } from "@/lib/db";
import { exchangeCode } from "@/lib/google";

export const runtime = "edge";
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
  const url = new URL(req.url);
  const origin = url.origin;

  // Google reports user-cancelled consent here rather than as an error page.
  const oauthError = url.searchParams.get("error");
  if (oauthError) return fail(origin, `Google sign-in was cancelled (${oauthError}).`);

  // 1. CSRF: the state Google echoed back must match our signed cookie.
  const cookieState = await readState(readCookie(req, STATE_COOKIE));
  const returned = url.searchParams.get("state") ?? "";
  if (!cookieState || !returned || cookieState.nonce !== returned) {
    return fail(origin, "Sign-in link expired or was tampered with. Please try again.");
  }

  const code = url.searchParams.get("code") ?? "";
  if (!code) return fail(origin, "Google did not return an authorisation code.");

  // 2. Exchange the code server-side, using our client secret.
  const result = await exchangeCode(code, `${origin}/api/auth/callback`);
  if (!result.ok) return fail(origin, result.error);

  const { email, verified } = result.identity;
  if (!verified) return fail(origin, `${email} is not a verified Google address.`);
  if (!domainAllowed(email)) {
    return fail(origin, `${email} is not on an allowed domain for this instance.`);
  }
  if (!isAllowed(email)) {
    return fail(origin, `${email} is not on the allowlist for this instance.`);
  }

  // 3. Returning users keep their Composio identity so connections and memory
  //    follow them; new users get a fresh opaque one for later integrations.
  let composioUserId: string;
  try {
    const existing = await findUser(email);
    composioUserId = existing?.composio_user_id ?? newComposioUserId();
    await upsertUser(email, composioUserId);
  } catch (e) {
    return fail(origin, `Could not reach the database: ${String(e).slice(0, 120)}`);
  }

  const headers = new Headers({ location: new URL("/", origin).toString() });
  headers.append("set-cookie", sessionCookie(await createSession(email, composioUserId)));
  headers.append("set-cookie", clearState());

  return new Response(null, { status: 302, headers });
}
