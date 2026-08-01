import { CATEGORIES, categoryIndex } from "@/lib/catalog";
import { composioEnabled, listConnections, listToolkits } from "@/lib/composio";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * The integrations directory.
 *
 * Curated slugs are bucketed into packages; anything Composio offers that we
 * didn't categorise still ships to the client so the search box can reach all
 * 500-odd toolkits. Slugs we guessed wrong simply don't appear.
 */
export async function GET() {
  if (!composioEnabled()) {
    return Response.json({
      enabled: false,
      error: "Composio is not configured. Set COMPOSIO_API_KEY in Vercel.",
      categories: CATEGORIES.map((c) => ({ ...c, toolkits: [] })),
      other: [],
      connections: [],
    });
  }

  const [toolkitsRes, connectionsRes] = await Promise.all([listToolkits(), listConnections()]);

  if (!toolkitsRes.ok) {
    return Response.json(
      {
        enabled: true,
        error: toolkitsRes.error,
        categories: CATEGORIES.map((c) => ({ ...c, toolkits: [] })),
        other: [],
        connections: [],
      },
      { status: 200 },
    );
  }

  const connections = connectionsRes.ok ? connectionsRes.data : [];
  const connected = new Map(connections.map((c) => [c.toolkit, c]));
  const index = categoryIndex();
  const bySlug = new Map(toolkitsRes.data.map((t) => [t.slug, t]));

  const decorate = (slug: string) => {
    const t = bySlug.get(slug);
    if (!t) return null;
    const conn = connected.get(slug);
    return {
      ...t,
      connected: !!conn && conn.status === "ACTIVE",
      status: conn?.status ?? null,
      connectionId: conn?.id ?? null,
    };
  };

  const categories = CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    blurb: c.blurb,
    glyph: c.glyph,
    toolkits: c.slugs.map(decorate).filter(Boolean),
  })).filter((c) => c.toolkits.length > 0);

  // Everything not in a curated package — reachable via search only.
  const other = toolkitsRes.data
    .filter((t) => !index.has(t.slug))
    .map((t) => decorate(t.slug))
    .filter(Boolean);

  return Response.json({
    enabled: true,
    error: null,
    categories,
    other,
    connections,
    total: toolkitsRes.data.length,
  });
}
