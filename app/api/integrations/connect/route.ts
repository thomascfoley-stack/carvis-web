import { createConnectLink, deleteConnection } from "@/lib/composio";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Starts an OAuth flow for a toolkit and hands the browser the redirect URL. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const toolkit = String(body?.toolkit ?? "").trim().toLowerCase();
  if (!toolkit) return Response.json({ error: "No toolkit given." }, { status: 400 });

  const origin = new URL(req.url).origin;
  const res = await createConnectLink(toolkit, `${origin}/integrations?connected=${toolkit}`);

  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ redirectUrl: res.data.redirectUrl });
}

/** Revokes a connection. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "No connection id." }, { status: 400 });

  const res = await deleteConnection(id);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true });
}
