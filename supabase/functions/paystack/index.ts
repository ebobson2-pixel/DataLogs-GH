import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PAYSTACK = "https://api.paystack.co";
const MOMO: Record<string, string> = { mtn: "mtn", telecel: "vod", airteltigo: "atl", vod: "vod", atl: "atl" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "charge");
    const admin = createAdmin();

    if (action === "charge") return json(await startCharge(req, admin, body));
    if (action === "submit_otp") return json(await submit(admin, body, "/charge/submit_otp", { otp: body.otp, reference: body.reference }));
    if (action === "submit_pin") return json(await submit(admin, body, "/charge/submit_pin", { pin: body.pin, reference: body.reference }));
    if (action === "submit_phone") {
      return json(await submit(admin, body, "/charge/submit_phone", { phone: digits(body.phone), reference: body.reference }));
    }
    if (action === "status" || action === "check") return json(await paymentStatus(admin, String(body.reference || "")));
    if (action === "refund") return json(await processPaystackRefund(admin, body));
    return json({ ok: false, message: "Unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : "Payment failed" }, 400);
  }
});

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function createAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function secret() {
  const key = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
  if (!key) throw new Error("Paystack is not configured");
  return key;
}

function digits(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function ghanaPhone(value: unknown) {
  let phone = digits(value);
  if (phone.startsWith("233") && phone.length === 12) phone = `0${phone.slice(3)}`;
  if (phone.length === 9) phone = `0${phone}`;
  return phone;
}

function pesewas(amount: number) {
  return Math.round(Number(amount) * 100);
}

async function authUser(req: Request, admin: ReturnType<typeof createAdmin>) {
  const header = req.headers.get("Authorization") || "";
  const jwt = header.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.length < 40) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data.user || null;
}

async function startCharge(req: Request, admin: ReturnType<typeof createAdmin>, body: Record<string, unknown>) {
  const user = await authUser(req, admin);
  const kind = String(body.kind || "order");
  const channel = String(body.channel || "momo");
  const email = String(body.email || user?.email || "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Enter a valid email for your payment receipt");

  let amount = 0;
  let metadata: Record<string, unknown> = {};
  let userId = user?.id || null;

  if (kind === "wallet_topup") {
    if (!user) throw new Error("Sign in to top up your wallet");
    const { data: profile } = await admin.from("profiles").select("role, blocked").eq("id", user.id).maybeSingle();
    if (!profile || !["agent", "admin"].includes(profile.role)) throw new Error("Only agents can top up a wallet");
    if (profile.blocked) throw new Error("This account is blocked");
    amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 5) throw new Error("Minimum top-up is GH₵ 5");
    if (amount > 5000) throw new Error("Maximum top-up is GH₵ 5,000");
    metadata = { agent_id: user.id };
  } else if (kind === "agent_activation") {
    if (!user) throw new Error("Sign in to activate your agent account");
    const { data: profile } = await admin
      .from("profiles")
      .select("role, blocked, agent_activated")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile || profile.role !== "agent") throw new Error("Only agent accounts pay the activation fee");
    if (profile.blocked) throw new Error("This account is blocked");
    if (profile.agent_activated) throw new Error("This agent account is already activated");
    const { data: settings } = await admin
      .from("site_settings")
      .select("agent_activation_fee_enabled, agent_activation_fee")
      .eq("id", 1)
      .maybeSingle();
    if (!settings?.agent_activation_fee_enabled || Number(settings.agent_activation_fee) <= 0) {
      throw new Error("Agent signup is free right now. Refresh and open your dashboard.");
    }
    amount = Number(settings.agent_activation_fee);
    metadata = { agent_id: user.id };
  } else {
    const packageId = String(body.packageId || body.package_id || "");
    const recipient = String(body.recipientNumber || body.recipient_number || "");
    const pricingTier = String(body.pricingTier || body.pricing_tier || "retail");
    const storeId = body.agentStoreId || body.agent_store_id || null;
    if (!packageId || !recipient) throw new Error("Package and recipient are required");
    if (pricingTier === "agent" && !user) throw new Error("Sign in as an agent to buy wholesale");

    const { data: pkgRow, error: pkgErr } = await admin
      .from("packages")
      .select("id, network, active")
      .eq("id", packageId)
      .maybeSingle();
    if (pkgErr) throw pkgErr;
    if (!pkgRow?.active) throw new Error("Package not found");

    const { data: prettyRecipient, error: matchErr } = await admin.rpc("assert_recipient_matches_package", {
      p_recipient: recipient,
      p_package_id: packageId,
    });
    if (matchErr) throw new Error(matchErr.message || "Recipient number does not match this package network");
    const normalizedRecipient = String(prettyRecipient || recipient);

    const { data: quoted, error } = await admin.rpc("quote_order_amount", {
      p_package_id: packageId,
      p_pricing_tier: pricingTier,
      p_agent_store_id: storeId,
      p_buyer_id: user?.id || null,
    });
    if (error) throw error;
    const packageAmount = Number(quoted);
    if (!packageAmount || packageAmount <= 0) throw new Error("Could not price this package");
    const paystackFee = Math.round(packageAmount * 0.03 * 100) / 100;
    amount = Math.round((packageAmount + paystackFee) * 100) / 100;
    metadata = {
      package_id: packageId,
      recipient_number: normalizedRecipient,
      pricing_tier: pricingTier,
      agent_store_id: storeId,
      buyer_id: user?.id || null,
      package_amount: packageAmount,
      paystack_fee: paystackFee,
      paystack_fee_rate: 0.03,
      package_network: pkgRow.network,
    };
  }

  const reference = `DLG-${crypto.randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase()}`;
  const { error: insertErr } = await admin.from("payments").insert({
    reference,
    kind,
    status: "pending",
    amount,
    currency: "GHS",
    email,
    channel,
    user_id: userId,
    metadata,
  });
  if (insertErr) throw insertErr;

  const payload: Record<string, unknown> = {
    email,
    amount: pesewas(amount),
    currency: "GHS",
    reference,
    metadata: { kind, ...metadata },
  };

  if (channel === "card") {
    const card = (body.card || {}) as Record<string, string>;
    const number = digits(card.number);
    if (number.length < 13) throw new Error("Enter a valid card number");
    payload.card = {
      number,
      cvv: String(card.cvv || "").trim(),
      expiry_month: String(card.expiry_month || card.month || "").padStart(2, "0"),
      expiry_year: String(card.expiry_year || card.year || "").slice(-2),
    };
  } else {
    const momo = (body.momo || {}) as Record<string, string>;
    const phone = ghanaPhone(momo.phone || body.momoPhone);
    const provider = MOMO[String(momo.provider || body.momoProvider || "mtn")] || "mtn";
    if (phone.length < 10) throw new Error("Enter the Mobile Money number that will pay");
    payload.mobile_money = { phone, provider };
  }

  const charged = await paystack("/charge", payload);
  const data = (charged.data || {}) as Record<string, unknown>;
  await admin.from("payments").update({
    paystack_id: data.id != null ? String(data.id) : null,
    last_error: charged.status ? null : charged.message || "Charge failed",
  }).eq("reference", reference);

  return present(admin, reference, data, charged.message);
}

async function submit(
  admin: ReturnType<typeof createAdmin>,
  body: Record<string, unknown>,
  path: string,
  payload: Record<string, unknown>
) {
  const reference = String(body.reference || payload.reference || "");
  if (!reference) throw new Error("Missing payment reference");
  const charged = await paystack(path, payload);
  const data = (charged.data || {}) as Record<string, unknown>;
  return present(admin, reference, data, charged.message);
}

function fulfillInBackground(orderId: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !orderId) return;
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

async function paymentStatus(admin: ReturnType<typeof createAdmin>, reference: string) {
  if (!reference) throw new Error("Missing payment reference");
  const { data: row } = await admin.from("payments").select("*").eq("reference", reference).maybeSingle();
  if (!row) throw new Error("Payment not found");
  let justCompleted = false;
  if (row.status === "pending") {
    const verified = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`, null, "GET");
    const status = String(verified.data?.status || "");
    if (status === "success") {
      await admin.rpc("complete_confirmed_payment", { p_reference: reference }).catch(() => {});
      justCompleted = true;
    } else if (status === "failed" || status === "abandoned") {
      await admin.from("payments").update({ status: status === "failed" ? "failed" : "abandoned" }).eq("reference", reference);
    }
  }
  const { data: fresh } = await admin.from("payments").select("*").eq("reference", reference).maybeSingle();
  let order = null;
  if (fresh?.order_id) {
    const { data } = await admin.from("orders").select("*").eq("id", fresh.order_id).maybeSingle();
    order = data;
    // Kick SwiftData once, as soon as this request creates the paid order.
    if (justCompleted && order?.id) {
      fulfillInBackground(String(order.id));
    }
  }
  return {
    ok: true,
    reference,
    status: fresh?.status,
    next: fresh?.status === "success" ? "success" : "pending",
    amount: fresh?.amount,
    order,
    payment: { kind: fresh?.kind, status: fresh?.status, order_id: fresh?.order_id },
  };
}

async function present(
  admin: ReturnType<typeof createAdmin>,
  reference: string,
  data: Record<string, unknown>,
  message?: string
) {
  const status = String(data.status || "");
  let next = "pending";
  let hint = message || "Complete the payment on your phone.";
  if (status === "success" || status === "successful") {
    next = "success";
    hint = "Payment confirmed.";
    const paid = await paymentStatus(admin, reference);
    return { ...paid, next: "success", display_text: hint };
  }
  if (status === "send_otp") {
    next = "otp";
    hint = String(data.display_text || "Enter the OTP sent to your phone.");
  } else if (status === "send_pin") {
    next = "pin";
    hint = "Enter your card PIN.";
  } else if (status === "send_phone") {
    next = "phone";
    hint = "Confirm the phone number on this card.";
  } else if (status === "pay_offline" || status === "pending" || status === "open_url") {
    next = "offline";
    hint = String(data.display_text || "Approve the Mobile Money prompt on your phone.");
  } else if (status === "failed") {
    next = "failed";
    hint = String(data.message || message || "Payment failed.");
    await admin.from("payments").update({ status: "failed", last_error: hint }).eq("reference", reference);
  }
  return {
    ok: next !== "failed",
    reference,
    next,
    display_text: hint,
    status,
    url: data.url || data.redirecturl || null,
  };
}

async function processPaystackRefund(admin: ReturnType<typeof createAdmin>, body: Record<string, unknown>) {
  const refundId = String(body.refund_id || "");
  if (!refundId) throw new Error("Missing refund_id");

  const prep = await admin.rpc("process_refund", { p_refund_id: refundId });
  if (prep.error) throw new Error(prep.error.message);
  const payload = prep.data as Record<string, unknown>;
  if (payload?.already) return { ok: true, ...(payload as object) };
  if (payload?.channel === "wallet") return { ok: true, ...(payload as object) };

  const paymentRef = String(payload?.payment_reference || "");
  if (!paymentRef) throw new Error("Missing payment reference for refund");

  const refundRes = await paystack("/refund", {
    transaction: paymentRef,
    merchant_note: `DataLogs refund ${refundId}`,
  });

  const paystackId = String(refundRes?.data?.id || refundRes?.data?.transaction?.id || "");
  const complete = await admin.rpc("complete_refund", {
    p_refund_id: refundId,
    p_paystack_refund_id: paystackId || null,
    p_success: true,
    p_error: null,
  });
  if (complete.error) throw new Error(complete.error.message);
  return { ok: true, ...(complete.data as object), paystack: refundRes?.data || null };
}

async function paystack(path: string, body: Record<string, unknown> | null, method = "POST") {
  const res = await fetch(`${PAYSTACK}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.status) {
    throw new Error(data.message || "Paystack request failed");
  }
  if (data.status === false) throw new Error(data.message || "Paystack request failed");
  return data;
}
