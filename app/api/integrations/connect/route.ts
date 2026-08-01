import { sessionFromRequest } from "@/lib/auth";
import { createConnectLink, deleteConnection, listConnections } from "@/lib/composio";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Starts an OAuth flow for a toolkit and hands the browser the redirect URL. */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const toolkit = String(body?.toolkit ?? "").trim().toLowerCase();
  if (!toolkit) return Response.json({ error: "No toolkit given." }, { status: 400 });

  const origin = new URL(req.url).origin;
  const res = await createConnectLink(
    toolkit,
    `${origin}/integrations?connected=${toolkit}`,
    session.cid,
  );

  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ redirectUrl: res.data.redirectUrl });
}

/** Revokes a connection — but only one belonging to the caller. */
export async function DELETE(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "No connection id." }, { status: 400 });

  // Ownership check: without this, any signed-in user could delete any
  // connection id they guessed, including another tenant's.
  const mine = await listConnections(session.cid);
  if (!mine.ok) return Response.json({ error: mine.error }, { status: 400 });
  if (!mine.data.some((c) => c.id === id)) {
    return Response.json({ error: "That connection isn't yours." }, { status: 403 });
  }

  const res = await deleteConnection(id);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true });
}
