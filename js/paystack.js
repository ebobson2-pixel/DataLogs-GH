window.DataLogsPay = (() => {
  async function request(body) {
    const cfg = window.DATALOGS_CONFIG;
    const session = typeof DataLogsAPI?.getSession === "function" ? await DataLogsAPI.getSession() : null;
    const token = session?.access_token || cfg.supabaseAnonKey;
    const res = await fetch(`${cfg.supabaseUrl}/functions/v1/paystack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.message || "Payment failed");
    return data;
  }

  return {
    charge(payload) {
      return request({ action: "charge", ...payload });
    },
    submitOtp(reference, otp) {
      return request({ action: "submit_otp", reference, otp });
    },
    submitPin(reference, pin) {
      return request({ action: "submit_pin", reference, pin });
    },
    submitPhone(reference, phone) {
      return request({ action: "submit_phone", reference, phone });
    },
    status(reference) {
      return request({ action: "status", reference });
    },
    refund(refundId) {
      return request({ action: "refund", refund_id: refundId });
    },
  };
})();
