/**
 * Composio client — tool execution plus the admin surface the Integrations
 * page needs (browse toolkits, see what's connected, start an OAuth flow).
 *
 * Response shapes vary a little across endpoints and versions, so every reader
 * here is deliberately tolerant about where it looks for a field.
 */

const BASE = "https://backend.composio.dev/api/v3";

const apiKey = () => (process.env.COMPOSIO_API_KEY || "").trim();
export const composioEnabled = () => !!apiKey();

/**
 * Every function below takes an explicit `userId`. There is deliberately no
 * ambient/default user: this app is multi-tenant, and a shared identity would
 * mean one person's Gmail was readable by another. Making the parameter
 * required is what stops that being reintroduced by accident.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Strip anything key-shaped out of an error before it can reach a URL, a log,
 * or a browser. Upstream services echo the offending credential back in
 * validation errors ("Invalid API key: sk-...owAA"), and our error strings end
 * up in /login?error=, which is exactly where secrets must never appear.
 */
export function redact(message: string): string {
  return message
    .replace(/\b(sk|ak|pk|rk|xi|key)[-_][A-Za-z0-9_\-*]{6,}/gi, "$1_[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, "[redacted]")
    .replace(/(Bearer|api[-_]?key["'\s:=]+)\s*\S+/gi, "$1 [redacted]");
}

async function call<T = any>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<Result<T>> {
  if (!composioEnabled()) return { ok: false, error: "Composio is not configured." };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: { "x-api-key": apiKey(), "content-type": "application/json" },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init?.signal,
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Composio: ${redact(String(e)).slice(0, 160)}` };
  }

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const msg =
      (body && (body.error?.message || body.error || body.message)) || `HTTP ${res.status}`;
    return { ok: false, error: redact(String(msg)).slice(0, 300) };
  }
  return { ok: true, data: body as T };
}

/* --------------------------- tool execution --------------------------- */

export async function composioExecute(
  slug: string,
  args: Record<string, unknown>,
  userId: string,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  if (!userId) return { ok: false, error: "No Composio user id for this session." };

  const res = await call<any>(`/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: { user_id: userId, arguments: args },
    signal,
  });
  if (!res.ok) return res;

  const body: any = res.data;
  if (body && typeof body === "object" && "successful" in body) {
    if (body.successful === false) {
      return { ok: false, error: redact(String(body.error ?? "Tool reported failure")).slice(0, 300) };
    }
    return { ok: true, data: body.data ?? body };
  }
  return { ok: true, data: body };
}

/* ------------------------------ toolkits ------------------------------ */

export type Toolkit = {
  slug: string;
  name: string;
  logo: string;
  description: string;
};

function items(body: any): any[] {
  if (Array.isArray(body)) return body;
  for (const k of ["items", "data", "toolkits", "results"]) {
    const v = body?.[k];
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.items)) return v.items;
  }
  return [];
}

function normaliseToolkit(t: any): Toolkit | null {
  const slug = t?.slug ?? t?.key ?? t?.name;
  if (!slug || typeof slug !== "string") return null;
  return {
    slug: slug.toLowerCase(),
    name: t?.name ?? t?.display_name ?? slug,
    logo: t?.meta?.logo ?? t?.logo ?? "",
    description: String(t?.meta?.description ?? t?.description ?? "").slice(0, 180),
  };
}

export async function listToolkits(signal?: AbortSignal): Promise<Result<Toolkit[]>> {
  const res = await call<any>("/toolkits?limit=500", { signal });
  if (!res.ok) return res;
  const list = items(res.data).map(normaliseToolkit).filter(Boolean) as Toolkit[];
  return { ok: true, data: list };
}

/* -------------------------- connected accounts ------------------------ */

export type Connection = { id: string; toolkit: string; status: string };

export async function listConnections(
  userId: string,
  signal?: AbortSignal,
): Promise<Result<Connection[]>> {
  const res = await call<any>(
    `/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=200`,
    { signal },
  );
  if (!res.ok) return res;

  const list: Connection[] = items(res.data)
    .map((c: any) => {
      const slug =
        c?.toolkit?.slug ?? c?.toolkit ?? c?.appName ?? c?.app_name ?? c?.toolkit_slug ?? "";
      if (!slug) return null;
      return {
        id: String(c?.id ?? c?.nanoid ?? ""),
        toolkit: String(slug).toLowerCase(),
        status: String(c?.status ?? "ACTIVE").toUpperCase(),
      };
    })
    .filter(Boolean) as Connection[];

  return { ok: true, data: list };
}

export async function deleteConnection(id: string): Promise<Result<unknown>> {
  return call(`/connected_accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Used by the login callback to confirm the OAuth flow actually completed. */
export async function getConnection(id: string): Promise<Result<Connection>> {
  const res = await call<any>(`/connected_accounts/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  const c = res.data?.data ?? res.data;
  return {
    ok: true,
    data: {
      id: String(c?.id ?? id),
      toolkit: String(c?.toolkit?.slug ?? c?.toolkit ?? "").toLowerCase(),
      status: String(c?.status ?? "").toUpperCase(),
    },
  };
}

/** Reads the Google address behind a freshly connected Gmail account. */
export async function gmailAddress(userId: string): Promise<string> {
  const res = await composioExecute("GMAIL_GET_PROFILE", { user_id: "me" }, userId);
  if (!res.ok) return "";
  const d: any = res.data;
  return String(
    d?.emailAddress ?? d?.email_address ?? d?.response_data?.emailAddress ?? d?.email ?? "",
  ).toLowerCase();
}

/* ------------------------------ auth flow ----------------------------- */

/**
 * Find an existing auth config for a toolkit, or create one backed by
 * Composio-managed OAuth so you don't have to register your own app.
 */
async function ensureAuthConfig(toolkit: string): Promise<Result<string>> {
  const existing = await call<any>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=10`,
  );
  if (existing.ok) {
    const found = items(existing.data).find((a: any) => a?.id);
    if (found?.id) return { ok: true, data: String(found.id) };
  }

  const created = await call<any>("/auth_configs", {
    method: "POST",
    body: {
      toolkit: { slug: toolkit },
      auth_config: { type: "use_composio_managed_auth" },
    },
  });
  if (!created.ok) return created;

  const id =
    created.data?.auth_config?.id ?? created.data?.id ?? created.data?.data?.id ?? null;
  if (!id) {
    return { ok: false, error: "Composio did not return an auth config id." };
  }
  return { ok: true, data: String(id) };
}

/** Returns the URL to send the user to in order to authorise a toolkit. */
export async function createConnectLink(
  toolkit: string,
  callbackUrl: string,
  userId: string,
): Promise<Result<{ redirectUrl: string; connectedAccountId: string }>> {
  if (!userId) return { ok: false, error: "No Composio user id for this session." };

  const cfg = await ensureAuthConfig(toolkit);
  if (!cfg.ok) return cfg;

  const link = await call<any>("/connected_accounts/link", {
    method: "POST",
    body: {
      auth_config_id: cfg.data,
      user_id: userId,
      callback_url: callbackUrl,
    },
  });
  if (!link.ok) return link;

  const redirectUrl =
    link.data?.redirect_url ?? link.data?.redirectUrl ?? link.data?.data?.redirect_url ?? "";

  if (!redirectUrl) {
    // Non-OAuth toolkits (API-key auth) have no redirect — say so plainly.
    return {
      ok: false,
      error:
        "That toolkit doesn't use OAuth. Connect it from the Composio dashboard, where you can supply its API key.",
    };
  }

  return {
    ok: true,
    data: {
      redirectUrl: String(redirectUrl),
      connectedAccountId: String(link.data?.connected_account_id ?? ""),
    },
  };
}

/* ------------------------------ shaping ------------------------------- */

/**
 * Tool results are injected into the model's context, so they have to be small.
 * A raw Gmail payload is tens of kilobytes of quoted HTML — slow to process and
 * actively harmful to answer quality.
 */
export function condense(value: unknown, maxLen = 3000): string {
  const seen = new WeakSet<object>();

  const prune = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return v.length > 600 ? v.slice(0, 600) + "…" : v;
    if (typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (depth > 5) return "[…]";
    if (Array.isArray(v)) return v.slice(0, 15).map((x) => prune(x, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(raw|payload|body|htmlBody|messageText|attachment|parts|headers|icon|photo)/i.test(k)) {
        continue;
      }
      out[k] = prune(val, depth + 1);
    }
    return out;
  };

  let s: string;
  try {
    s = JSON.stringify(prune(value, 0));
  } catch {
    s = String(value);
  }
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}
