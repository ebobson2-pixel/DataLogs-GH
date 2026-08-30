import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const PREFIXES: Record<string, string[]> = {
  mtn: ["024", "025", "053", "054", "055", "059"],
  airteltigo: ["026", "027", "056", "057"],
  telecel: ["020", "050"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const url = new URL(req.url);
  const path = routePath(url);
  const method = req.method.toUpperCase();
  const skipLog = method === "GET" && (path === "/" || path === "/health" || path === "/status");

  let admin: ReturnType<typeof createAdmin> | null = null;
  let agentId: string | null = null;
  let keyId: string | null = null;
  let orderCode: string | null = null;
  let status = 200;
  let ok = true;
  let errorMessage: string | null = null;

  const respond = (payload: Record<string, unknown>, code = 200) => {
    status = code;
    ok = code < 400;
    if (!ok) errorMessage = String(payload.message || errorMessage || "Request failed");
    return json(payload, code);
  };

  try {
    if (skipLog) {
      return json({
        ok: true,
        service: "DataLogs GH Agent API",
        version: "v1",
        base_url: "https://datalogsgh.shop/api/v1",
        docs: "https://datalogsgh.shop/docs.html",
      });
    }

    admin = createAdmin();
    const auth = await requireAgent(req, admin);
    agentId = auth.profile.id;
    keyId = auth.keyId;

    if (method === "GET" && path === "/packages") {
      return respond({
        ok: true,
        data: { packages: await listPackages(admin, auth.profile.id, url.searchParams.get("network")) },
      });
    }

    if (method === "GET" && path === "/wallet") {
      const { data } = await admin.from("wallets").select("balance, updated_at").eq("agent_id", auth.profile.id).maybeSingle();
      return respond({
        ok: true,
        data: { balance: Number(data?.balance || 0), currency: "GHS", updated_at: data?.updated_at || null },
      });
    }

    if (method === "GET" && path === "/orders") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const { data, error } = await admin
        .from("orders")
        .select("order_code, network, gb, recipient_number, amount_paid, delivery_status, created_at")
        .eq("buyer_id", auth.profile.id)
        .eq("pricing_tier", "agent")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return respond({ ok: true, data: { orders: (data || []).map(publicOrder) } });
    }

    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch) {
      const code = decodeURIComponent(orderMatch[1]);
      const { data, error } = await admin
        .from("orders")
        .select("order_code, network, gb, recipient_number, amount_paid, delivery_status, created_at")
        .eq("buyer_id", auth.profile.id)
        .eq("order_code", code)
        .maybeSingle();
      if (error) throw error;
      if (!data) return respond({ ok: false, error: "not_found", message: "Order not found" }, 404);
      orderCode = String(data.order_code || "");
      return respond({ ok: true, data: { order: publicOrder(data) } });
    }

    if (method === "POST" && path === "/orders") {
      const body = await req.json().catch(() => ({}));
      const order = await placeOrder(admin, auth.profile, body);
      orderCode = String(order.order_code || "");
      fulfillInBackground(String(order.id));
      return respond({ ok: true, data: { order: publicOrder(order) } }, 201);
    }

    return respond({ ok: false, error: "not_found", message: `Unknown route ${method} ${path}` }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    errorMessage = message;
    ok = false;
    status = /api key|sign-in|blocked|disabled/i.test(message) ? 401 : /not found/i.test(message) ? 404 : 400;
    return json({ ok: false, error: status === 401 ? "unauthorized" : "bad_request", message }, status);
  } finally {
    if (!skipLog && admin) {
      logApiRequest(admin, {
        agent_id: agentId,
        key_id: keyId,
        method,
        path,
        status_code: status,
        ok,
        error_message: errorMessage,
        ip: clientIp(req),
        order_code: orderCode,
        duration_ms: Date.now() - started,
      });
    }
  }
});

function routePath(url: URL) {
  const raw = url.pathname.replace(/\/+$/, "") || "/";
  for (const marker of ["/agent-api", "/api/v1"]) {
    const index = raw.indexOf(marker);
    if (index >= 0) return raw.slice(index + marker.length) || "/";
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function createAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function clientIp(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    null
  );
}

function logApiRequest(
  admin: ReturnType<typeof createClient>,
  row: {
    agent_id: string | null;
    key_id: string | null;
    method: string;
    path: string;
    status_code: number;
    ok: boolean;
    error_message: string | null;
    ip: string | null;
    order_code: string | null;
    duration_ms: number;
  }
) {
  admin
    .from("agent_api_requests")
    .insert({
      agent_id: row.agent_id,
      key_id: row.key_id,
      method: row.method,
      path: row.path.slice(0, 120),
      status_code: row.status_code,
      ok: row.ok,
      error_message: row.error_message ? String(row.error_message).slice(0, 240) : null,
      ip: row.ip,
      order_code: row.order_code,
      duration_ms: row.duration_ms,
    })
    .then(() => {});
}

async function sha256Hex(value: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readApiKey(req: Request) {
  const header = req.headers.get("x-api-key") || "";
  if (header.startsWith("dlg_live_")) return header.trim();
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer.startsWith("dlg_live_")) return bearer;
  return "";
}

async function requireAgent(req: Request, admin: ReturnType<typeof createClient>) {
  const apiKey = readApiKey(req);
  if (!apiKey) throw new Error("Missing API key. Send Authorization: Bearer dlg_live_…");
  const hash = await sha256Hex(apiKey);
  const { data: keyRow, error } = await admin
    .from("agent_api_keys")
    .select("id, agent_id, revoked_at")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error) throw error;
  if (!keyRow || keyRow.revoked_at) throw new Error("Invalid API key");

  const { data: profile } = await admin
    .from("profiles")
    .select("id, full_name, email, role, blocked, api_disabled")
    .eq("id", keyRow.agent_id)
    .maybeSingle();
  if (!profile) throw new Error("Invalid API key");
  if (profile.blocked) throw new Error("This account is blocked");
  if (profile.api_disabled) throw new Error("API access is disabled on this account");
  if (!["agent", "admin"].includes(profile.role)) throw new Error("Invalid API key");

  admin.from("agent_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});
  return { profile, keyId: keyRow.id as string };
}

function publicStatus(status: string | null | undefined) {
  return status === "delivered" || status === "completed" ? "completed" : "processing";
}

function publicOrder(row: Record<string, unknown>) {
  return {
    order_code: row.order_code,
    network: row.network,
    gb: Number(row.gb),
    recipient: row.recipient_number,
    amount: Number(row.amount_paid),
    currency: "GHS",
    status: publicStatus(String(row.delivery_status || "")),
    created_at: row.created_at,
  };
}

async function packagesAvailable(admin: ReturnType<typeof createClient>) {
  const { data } = await admin.from("site_settings").select("packages_available").eq("id", 1).maybeSingle();
  return data?.packages_available !== false;
}

async function listPackages(admin: ReturnType<typeof createClient>, agentId: string, network: string | null) {
  if (!(await packagesAvailable(admin))) return [];
  let query = admin
    .from("packages")
    .select("id, network, gb, agent_price, retail_price, validity")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (network && PREFIXES[network]) query = query.eq("network", network);
  const { data, error } = await query;
  if (error) throw error;
  const { data: custom } = await admin.from("user_custom_prices").select("package_id, agent_price").eq("user_id", agentId);
  const customMap = new Map((custom || []).map((row) => [row.package_id, Number(row.agent_price)]));
  return (data || []).map((pkg) => ({
    id: pkg.id,
    network: pkg.network,
    gb: Number(pkg.gb),
    price: customMap.has(pkg.id) ? customMap.get(pkg.id) : Number(pkg.agent_price),
    currency: "GHS",
    validity: pkg.validity || "Non expiry",
  }));
}

function ghanaNumber(raw: string, network: string) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) digits = `0${digits.slice(3)}`;
  if (digits.length === 9) digits = `0${digits}`;
  if (!/^0\d{9}$/.test(digits)) throw new Error("Enter a valid Ghana number, like 0241234567");
  const prefix = digits.slice(0, 3);
  const match = Object.entries(PREFIXES).find(([, list]) => list.includes(prefix));
  if (!match) throw new Error("That prefix is not MTN, AirtelTigo or Telecel");
  if (match[0] !== network) {
    throw new Error(`That number looks like ${match[0]}. Use a ${network} package.`);
  }
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

async function placeOrder(admin: ReturnType<typeof createClient>, agent: { id: string }, body: Record<string, unknown>) {
  if (!(await packagesAvailable(admin))) throw new Error("Packages unavailable");
  const recipient = String(body.recipient || body.recipient_number || body.phone || "").trim();
  if (!recipient) throw new Error("recipient is required");

  let packageId = String(body.package_id || body.packageId || "").trim();
  if (!packageId) {
    const network = String(body.network || "").toLowerCase().trim();
    const gb = Number(body.gb);
    if (!PREFIXES[network] || !gb) throw new Error("Send package_id, or network and gb");
    const { data: pkg } = await admin
      .from("packages")
      .select("id")
      .eq("active", true)
      .eq("network", network)
      .eq("gb", gb)
      .maybeSingle();
    if (!pkg) throw new Error("No package matches that network and size");
    packageId = pkg.id;
  }

  const { data: pkg, error: pkgErr } = await admin
    .from("packages")
    .select("id, network")
    .eq("id", packageId)
    .eq("active", true)
    .maybeSingle();
  if (pkgErr) throw pkgErr;
  if (!pkg) throw new Error("Package not found");

  const pretty = ghanaNumber(recipient, String(pkg.network));
  const { data, error } = await admin.rpc("api_place_agent_order", {
    p_agent_id: agent.id,
    p_package_id: packageId,
    p_recipient_number: pretty,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

function fulfillInBackground(orderId: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  fetch(`${url}/functions/v1/fulfill-order`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "fulfill", orderId }),
  }).catch(() => {});
}
