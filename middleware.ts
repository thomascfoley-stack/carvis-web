import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Redirect-only gate.
 *
 * Middleware runs on the Edge runtime, where Next inlines `process.env` at
 * build time — and Vercel does not expose "Sensitive" env vars to the build.
 * That means the HMAC secret here could differ from the one the Node-runtime
 * routes use, and every valid session would be rejected.
 *
 * So middleware does not verify signatures. It only checks that a session
 * cookie is *present*, purely so signed-out visitors land on /login instead of
 * a blank app shell. Real cryptographic verification happens in every API
 * route via sessionFromRequest(), which is where authorisation actually
 * matters — the shell renders no data on its own.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /mic is the microphone diagnostics page. It stays reachable signed-out on
  // purpose: debugging a device problem should not also be a debate about the
  // session, and it lets the same check run in an incognito window, which is
  // the cleanest way to rule an extension in or out. It reads nothing and
  // reports only the visitor's own browser back to themselves.
  if (pathname === "/login" || pathname === "/mic" || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // The PWA assets must stay reachable signed-out: iOS fetches the touch icon
  // and manifest without cookies, and a 307 to /login breaks Add-to-Home-Screen.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-touch-icon.png|manifest.webmanifest).*)",
  ],
};
