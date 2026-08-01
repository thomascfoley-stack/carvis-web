import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfigured, verifySession } from "@/lib/auth";

/**
 * Gate everything. This covers /api/chat and /api/tts too, so nobody can burn
 * your model or voice credits by calling the endpoints directly.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const open = pathname === "/login" || pathname.startsWith("/api/auth/");
  if (open) return NextResponse.next();

  // Before an allowlist exists the app stays reachable, otherwise a fresh
  // deploy would lock you out of the page that configures it.
  if (!authConfigured()) return NextResponse.next();

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
