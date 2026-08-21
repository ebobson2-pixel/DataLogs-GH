(function orderTrackerWidget() {
  if (document.getElementById("order-tracker-root")) return;
  if (document.body.classList.contains("dash-body")) return;

  const root = document.createElement("div");
  root.id = "order-tracker-root";
  root.innerHTML = `
    <button class="track-fab" type="button" id="track-fab" aria-label="Track your order">Track order</button>
    <div class="track-panel" id="track-panel" hidden>
      <div class="track-panel-head">
        <div>
          <strong>Track your order</strong>
          <p>Enter the Ghana number that received the data bundle for live status and full order details.</p>
        </div>
        <button class="track-close" type="button" id="track-close" aria-label="Close">×</button>
      </div>
      <form class="track-form" id="track-form">
        <input id="track-phone" inputmode="tel" placeholder="024 123 4567" autocomplete="tel" required>
        <button class="btn btn-primary" type="submit">Check status</button>
      </form>
      <p class="track-error" id="track-error" hidden></p>
      <div class="track-results" id="track-results"></div>
    </div>
  `;
  document.body.appendChild(root);

  const fab = root.querySelector("#track-fab");
  const panel = root.querySelector("#track-panel");
  if (document.body.classList.contains("store-body")) fab.hidden = true;
  const form = root.querySelector("#track-form");
  const phoneInput = root.querySelector("#track-phone");
  const errorEl = root.querySelector("#track-error");
  const results = root.querySelector("#track-results");
  let pollTimer = null;
  let lastPhone = "";

  function openPanel() {
    panel.hidden = false;
    fab.classList.add("open");
    phoneInput.focus();
  }

  function closePanel() {
    panel.hidden = true;
    fab.classList.remove("open");
    stopPoll();
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function statusClass(status) {
    return publicDeliveryStatus(status) === "completed" ? "is-delivered" : "is-processing";
  }

  function methodLabel(method) {
    const key = String(method || "").toLowerCase();
    if (key === "wallet") return "Wallet";
    if (key === "card") return "Card";
    if (key === "momo" || key === "mobile_money") return "Mobile Money";
    if (key === "paystack") return "Paystack";
    return method ? String(method) : "—";
  }

  function sourceLabel(order) {
    if (order.store_name) return `Agent store · ${order.store_name}`;
    return order.source || "DataLogs GH";
  }

  function statusHint(status, paymentStatus) {
    const done = publicDeliveryStatus(status) === "completed";
    if (done) {
      return "Data has been sent to the network for this number. It usually appears on the phone shortly.";
    }
    if (String(paymentStatus).toLowerCase() === "paid") {
      return "Payment is confirmed. We are sending the bundle to the network now.";
    }
    return "We are confirming payment and preparing this bundle for delivery.";
  }

  function timelineHtml(order) {
    const paid = String(order.payment_status).toLowerCase() === "paid";
    const done = publicDeliveryStatus(order.delivery_status) === "completed";
    const steps = [
      { id: "placed", label: "Order placed", done: true, active: false },
      { id: "paid", label: "Payment confirmed", done: paid || done, active: !paid && !done },
      { id: "send", label: "Sending to network", done: done, active: paid && !done },
      { id: "done", label: "Completed", done: done, active: false },
    ];
    return `
      <ol class="track-timeline" aria-label="Order progress">
        ${steps
          .map(
            (step) => `
          <li class="${step.done ? "done" : ""} ${step.active ? "active" : ""}">
            <span class="track-timeline-dot" aria-hidden="true"></span>
            <span>${step.label}</span>
          </li>`
          )
          .join("")}
      </ol>
    `;
  }

  function detailRow(label, value) {
    return `
      <div class="track-detail-row">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
    `;
  }

  function renderOrders(orders) {
    if (!orders.length) {
      results.innerHTML = `
        <p class="track-empty">No orders found for that number.</p>
        <p class="track-empty">Use the exact recipient number entered at checkout. If you just paid, wait a moment and check again.</p>
      `;
      return;
    }
    results.innerHTML = `
      <p class="track-summary">${orders.length} recent order${orders.length === 1 ? "" : "s"} found · live updates every few seconds</p>
      ${orders
        .map((o) => {
          const when = formatOrderDateTime(o.created_at);
          const updated = formatOrderDateTime(o.updated_at || o.created_at);
          const network = NETWORKS[o.network]?.name || o.network;
          const status = publicDeliveryLabel(o.delivery_status);
          const paidLabel = String(o.payment_status).toLowerCase() === "paid" ? "Paid" : "Confirming payment";
          return `
          <article class="track-card ${statusClass(o.delivery_status)}">
            <div class="track-card-top">
              <div>
                <strong>${o.order_code || "Order"}</strong>
                <p class="track-meta" style="margin:4px 0 0">${escapeHtml(sourceLabel(o))}</p>
              </div>
              <span class="track-status">${status}</span>
            </div>
            <p class="track-bundle">${network} · ${o.gb} GB</p>
            <p class="track-hint">${statusHint(o.delivery_status, o.payment_status)}</p>
            ${timelineHtml(o)}
            <div class="track-details">
              ${detailRow("Recipient", escapeHtml(o.recipient_number || "—"))}
              ${detailRow("Amount paid", formatCedi(o.amount_paid))}
              ${detailRow("Payment", `${paidLabel} · ${methodLabel(o.payment_method)}`)}
              ${detailRow("Validity", escapeHtml(o.validity || "Non expiry"))}
              ${detailRow("Ordered", `${when.date} · ${when.time}`)}
              ${detailRow("Last update", `${updated.date} · ${updated.time}`)}
            </div>
          </article>`;
        })
        .join("")}
    `;
  }

  async function lookup(phone, { silent } = {}) {
    errorEl.hidden = true;
    try {
      const orders = await trackByPhone(phone);
      renderOrders(orders || []);
      lastPhone = phone;
    } catch (err) {
      if (!silent) {
        errorEl.hidden = false;
        errorEl.textContent = err.message || "Could not load orders.";
        results.innerHTML = "";
      }
    }
  }

  async function trackByPhone(phone) {
    if (typeof window.DataLogsAPI?.trackOrdersByPhone === "function") {
      return window.DataLogsAPI.trackOrdersByPhone(phone);
    }
    const client = window.DataLogsAPI?.client || trackingClient();
    if (!client) throw new Error("Tracking is unavailable right now. Refresh the page and try again.");
    const { data, error } = await client.rpc("track_orders_by_phone", { p_phone: phone });
    if (error) throw error;
    return data || [];
  }

  function trackingClient() {
    const cfg = window.DATALOGS_CONFIG;
    if (!window.supabase || !cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return null;
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }

  fab.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });
  root.querySelector("#track-close").addEventListener("click", closePanel);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const phone = phoneInput.value.trim();
    results.innerHTML = `<p class="track-empty">Checking live status and order details…</p>`;
    await lookup(phone);
    stopPoll();
    if (lastPhone) {
      pollTimer = setInterval(() => lookup(lastPhone, { silent: true }), 8000);
    }
  });

  window.DataLogsTrack = { open: openPanel, close: closePanel };
})();
