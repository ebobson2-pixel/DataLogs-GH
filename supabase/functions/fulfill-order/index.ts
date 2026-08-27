import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SWIFT_BASE = "https://ihrvvniomtoofrjkmalb.supabase.co/functions/v1/api/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "fulfill");
    const admin = createAdmin();

    if (action === "balance") {
      await requireAdmin(req, admin);
      const bal = await swiftJson("/balance", { method: "GET" });
      return json({ ok: true, balance: bal.balance ?? bal.data?.balance ?? 0, currency: bal.currency || "GHS" });
    }

    // Public track refresh: poll provider and flip delivery_status to delivered when done.
    if (action === "sync_status" || action === "sync") {
      return json(await syncOrderStatus(admin, body));
    }

    const orderId = body.orderId || body.order_id;
    if (!orderId) return json({ ok: false, message: "Missing orderId" }, 400);

    const { data: order, error } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (error) throw error;
    if (!order) return json({ ok: false, message: "Order not found" }, 404);

    await authorizeFulfill(req, admin, order, action);

    if (action === "retry") {
      await requireAdmin(req, admin);
      if (order.fail_reason !== "low_balance" || !order.retryable) {
        return json({ ok: false, message: "Only low-balance failures can be retried." }, 400);
      }
    } else if (order.delivery_status === "delivered") {
      return json({ ok: true, order, skipped: true, message: "Already delivered" });
    } else if (order.provider_ref && order.fail_reason !== "low_balance") {
      const polled = await pollAndStore(admin, order);
      return json({ ok: true, order: polled });
    }

    const result = await buyAndStore(admin, order, action === "retry");
    return json(result, result.ok ? 200 : 200);
  } catch (err) {
    return json({ ok: false, message: err.message || "Fulfillment failed" }, 400);
  }
});

async function syncOrderStatus(admin: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const orderId = body.orderId || body.order_id;
  const rawCode = String(body.orderCode || body.order_code || body.code || "").trim();
  let order: Record<string, unknown> | null = null;

  if (orderId) {
    const { data, error } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (error) throw error;
    order = data;
  } else if (rawCode) {
    const code = normalizeOrderCode(rawCode);
    const { data, error } = await admin
      .from("orders")
      .select("*")
      .ilike("order_code", code)
      .maybeSingle();
    if (error) throw error;
    order = data;
  } else {
    return { ok: false, message: "Missing order code" };
  }

  if (!order) return { ok: false, message: "Order not found" };
  if (String(order.payment_status) !== "paid") {
    return { ok: true, order, message: "Payment not confirmed yet" };
  }
  if (String(order.delivery_status) === "delivered") {
    return { ok: true, order, skipped: true, message: "Already delivered" };
  }

  // Poll provider first when we already submitted (covers admin retries and manual resends).
  if (order.provider_ref) {
    const polled = await pollAndStore(admin, order);
    if (String(polled.delivery_status) !== "failed") {
      return { ok: true, order: polled, synced: true };
    }
    order = polled;
  }

  if (order.retryable && order.fail_reason === "low_balance") {
    const result = await buyAndStore(admin, order, true);
    return { ...result, synced: true };
  }

  if (!order.provider_ref && String(order.delivery_status) !== "failed") {
    const result = await buyAndStore(admin, order, false);
    return { ...result, synced: true };
  }

  return {
    ok: true,
    order,
    synced: true,
    message: String(order.delivery_status) === "failed" ? "Delivery failed" : "Status unchanged",
  };
}

function normalizeOrderCode(raw: string) {
  let code = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!code) return "";
  if (/^[0-9A-F]{8}$/.test(code)) code = "DL" + code;
  if (/^DL[0-9A-F]{8}$/.test(code)) return "DL-" + code.slice(2);
  if (code.startsWith("DL") && code.length > 2) return "DL-" + code.slice(2);
  return code;
}

function isServiceRole(req: Request) {
  const header = req.headers.get("Authorization") || "";
  const jwt = header.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return !!(serviceKey && jwt && jwt === serviceKey);
}

async function getRequestUser(req: Request) {
  const header = req.headers.get("Authorization") || "";
  const jwt = header.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.length < 40) return null;
  if (isServiceRole(req)) return null;
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const userClient = createClient(url, anon || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

async function authorizeFulfill(
  req: Request,
  admin: ReturnType<typeof createClient>,
  order: Record<string, unknown>,
  action: string,
) {
  if (isServiceRole(req)) return;

  if (action !== "retry" && order.payment_status !== "paid") {
    throw new Error("Order is not paid");
  }

  const user = await getRequestUser(req);
  if (!user) throw new Error("Sign-in required to fulfill this order");

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role === "admin") return;

  if (action === "retry") throw new Error("Admins only");

  if (order.buyer_id && order.buyer_id === user.id) return;

  // Guest checkouts: only the payment owner may trigger client-side fulfill
  if (!order.buyer_id) {
    const { data: pay } = await admin
      .from("payments")
      .select("user_id, status")
      .eq("order_id", order.id)
      .eq("status", "success")
      .maybeSingle();
    if (pay?.user_id && pay.user_id === user.id) return;
  }

  throw new Error("Not allowed to fulfill this order");
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

async function requireAdmin(req: Request, admin: ReturnType<typeof createClient>) {
  const header = req.headers.get("Authorization") || "";
  const jwt = header.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.length < 40) throw new Error("Admin sign-in required");
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const userClient = createClient(url, anon || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(jwt);
  if (error || !data.user) throw new Error("Admin sign-in required");
  const { data: profile } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (profile?.role !== "admin") throw new Error("Admins only");
  return data.user;
}

function providerNetworks(local: string) {
  if (local === "mtn") return ["yello"];
  if (local === "telecel") return ["telecel"];
  if (local === "airteltigo") return ["at_bigtime", "at_ishare"];
  return [local];
}

/** Fixed SwiftData network ids — skip GET /packages on the hot path. */
function primaryProviderNetwork(local: string) {
  return providerNetworks(local)[0] || local;
}

function isUnknownPackageError(payload: Record<string, unknown>) {
  const blob = `${payload._http || ""} ${JSON.stringify(payload || {})}`.toLowerCase();
  return (
    /unknown package|package not found|invalid (network|package)|no package|size_gb|not available/.test(blob)
  );
}

function localPhone(raw: string) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) digits = "0" + digits.slice(3);
  if (digits.length === 9) digits = "0" + digits;
  return digits;
}

function isLowBalance(status: number, payload: unknown) {
  const blob = `${status} ${JSON.stringify(payload || {})}`.toLowerCase();
  return (
    status === 402 ||
    /insufficient/.test(blob) ||
    /low[_\s-]?balance/.test(blob) ||
    /not enough (funds|balance|credit)/.test(blob) ||
    /(wallet|balance).*(empty|low|insufficient)/.test(blob)
  );
}

function mapDelivery(status: string | undefined) {
  const s = String(status || "").toLowerCase().trim();
  if (
    s === "completed" ||
    s === "complete" ||
    s === "success" ||
    s === "successful" ||
    s === "delivered" ||
    s === "sent" ||
    s === "done" ||
    s === "ok"
  ) {
    return "delivered";
  }
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled" || s === "rejected") {
    return "failed";
  }
  return "processing";
}

async function swiftJson(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("SWIFTDATA_API_KEY");
  if (!key) throw new Error("Provider API key is not configured");
  const res = await fetch(`${SWIFT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { ...payload, _http: res.status, _ok: res.ok };
}

async function resolveProviderNetworkFromCatalog(localNetwork: string, gb: number) {
  const wanted = providerNetworks(localNetwork);
  const catalog = await swiftJson("/packages", { method: "GET" });
  const packages = (catalog.packages as Array<Record<string, unknown>>) || [];
  for (const net of wanted) {
    const hit = packages.find((p) => String(p.network) === net && Math.abs(Number(p.size_gb) - gb) < 0.001);
    if (hit) return net;
  }
  return wanted[0];
}

async function buyDataWithNetworkFallback(phone: string, localNetwork: string, gb: number, reference: string) {
  const candidates = providerNetworks(localNetwork);
  let network = primaryProviderNetwork(localNetwork);
  let payload = await swiftJson("/buy-data", {
    method: "POST",
    body: JSON.stringify({ phone, network, size_gb: gb, reference }),
  });

  // If primary map misses (e.g. AT ishare vs bigtime), try alternates then catalog once.
  if ((!payload._ok || payload.success === false) && isUnknownPackageError(payload)) {
    for (const alt of candidates.slice(1)) {
      network = alt;
      payload = await swiftJson("/buy-data", {
        method: "POST",
        body: JSON.stringify({ phone, network, size_gb: gb, reference }),
      });
      if (payload._ok && payload.success !== false) return { network, payload };
    }
    network = await resolveProviderNetworkFromCatalog(localNetwork, gb);
    payload = await swiftJson("/buy-data", {
      method: "POST",
      body: JSON.stringify({ phone, network, size_gb: gb, reference }),
    });
  }

  return { network, payload };
}

async function buyAndStore(admin: ReturnType<typeof createClient>, order: Record<string, unknown>, isRetry: boolean) {
  const phone = localPhone(String(order.recipient_number || ""));
  if (!/^0\d{9}$/.test(phone)) {
    return saveFailure(admin, order, "Invalid recipient number", "provider_error", false);
  }

  const gb = Number(order.gb);
  const reference = String(order.order_code);
  const { network, payload } = await buyDataWithNetworkFallback(phone, String(order.network), gb, reference);

  if (!payload._ok || payload.success === false) {
    const low = isLowBalance(Number(payload._http), payload);
    const message =
      String(payload.message || payload.error || payload.raw || "Provider rejected the order");
    return saveFailure(admin, order, message, low ? "low_balance" : "provider_error", low, network, isRetry);
  }

  const providerOrder = (payload.order as Record<string, unknown>) || payload;
  const providerStatus = String(providerOrder.status || payload.status || "processing");
  const patch = {
    provider_ref: providerOrder.reference || reference,
    provider_status: providerStatus,
    provider_network: network,
    provider_error: null,
    fail_reason: null,
    retryable: false,
    delivery_status: mapDelivery(providerStatus),
    last_retry_at: isRetry ? new Date().toISOString() : order.last_retry_at,
    retry_count: isRetry ? Number(order.retry_count || 0) + 1 : order.retry_count,
  };

  if (patch.delivery_status === "processing" && patch.provider_ref) {
    const polled = await swiftJson(`/orders/${encodeURIComponent(String(patch.provider_ref))}`, { method: "GET" });
    const polledOrder = (polled.order as Record<string, unknown>) || polled;
    if (polledOrder.status) {
      patch.provider_status = String(polledOrder.status);
      patch.delivery_status = mapDelivery(String(polledOrder.status));
    }
  }

  const { data, error } = await admin.from("orders").update(patch).eq("id", order.id).select().single();
  if (error) throw error;
  return {
    ok: true,
    retryable: false,
    fail_reason: null,
    message: patch.delivery_status === "delivered" ? "Delivered" : "Sent to provider",
    order: data,
  };
}

async function pollAndStore(admin: ReturnType<typeof createClient>, order: Record<string, unknown>) {
  const ref = String(order.provider_ref);
  const polled = await swiftJson(`/orders/${encodeURIComponent(ref)}`, { method: "GET" });
  const providerOrder = (polled.order as Record<string, unknown>) || polled;
  const status = String(providerOrder.status || order.provider_status || "processing");
  const { data, error } = await admin
    .from("orders")
    .update({
      provider_status: status,
      delivery_status: mapDelivery(status),
    })
    .eq("id", order.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function saveFailure(
  admin: ReturnType<typeof createClient>,
  order: Record<string, unknown>,
  message: string,
  failReason: string,
  retryable: boolean,
  network?: string,
  isRetry = false
) {
  const { data, error } = await admin
    .from("orders")
    .update({
      delivery_status: "failed",
      provider_error: message.slice(0, 500),
      fail_reason: failReason,
      retryable,
      provider_network: network || order.provider_network || null,
      last_retry_at: isRetry ? new Date().toISOString() : order.last_retry_at,
      retry_count: isRetry ? Number(order.retry_count || 0) + 1 : order.retry_count,
    })
    .eq("id", order.id)
    .select()
    .single();
  if (error) throw error;
  return {
    ok: false,
    retryable,
    fail_reason: failReason,
    message,
    order: data,
  };
}
