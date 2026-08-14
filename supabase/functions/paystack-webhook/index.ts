import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-paystack-signature, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
  const raw = await req.text();
  const signature = req.headers.get("x-paystack-signature") || "";
  if (!secret || !(await validSignature(raw, signature, secret))) {
    return json({ ok: false, message: "Invalid signature" }, 401);
  }

  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ ok: false, message: "Invalid JSON" }, 400);
  }

  const eventName = String(event.event || "");
  const data = (event.data || {}) as Record<string, unknown>;
  const reference = String(data.reference || "");
  if (!reference) return json({ ok: true, skipped: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  try {
    if (eventName === "charge.success" || String(data.status) === "success") {
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const body = await verified.json();
      if (body?.data?.status !== "success") return json({ ok: true, skipped: true, reason: "not_verified" });

      const result = await admin.rpc("complete_confirmed_payment", { p_reference: reference });
      if (result.error) throw result.error;

      const orderId = result.data?.order?.id || result.data?.payment?.order_id;
      if (orderId) {
        const url = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (url && key) {
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
      }
      return json({ ok: true, reference });
    }

    if (eventName === "charge.failed" || String(data.status) === "failed") {
      await admin
        .from("payments")
        .update({ status: "failed", last_error: String(data.gateway_response || data.message || "Failed") })
        .eq("reference", reference)
        .eq("status", "pending");
    }
    return json({ ok: true, reference, event: eventName });
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : "Webhook failed" }, 400);
  }
});

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function validSignature(raw: string, signature: string, secret: string) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === signature.toLowerCase();
}
