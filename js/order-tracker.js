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
          <p>Enter the Ghana number the bundle was sent to.</p>
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

  function renderOrders(orders) {
    if (!orders.length) {
      results.innerHTML = `<p class="track-empty">No orders found for that number. Use the recipient number from checkout.</p>`;
      return;
    }
    results.innerHTML = orders
      .map((o) => {
        const when = formatOrderDateTime(o.created_at);
        const network = NETWORKS[o.network]?.name || o.network;
        const status = publicDeliveryLabel(o.delivery_status);
        return `
          <article class="track-card ${statusClass(o.delivery_status)}">
            <div class="track-card-top">
              <strong>${o.order_code || "Order"}</strong>
              <span class="track-status">${status}</span>
            </div>
            <p>${network} · ${o.gb} GB · ${formatCedi(o.amount_paid)}</p>
            <p class="track-meta">${o.source || "DataLogs"} · ${when.date} · ${when.time}</p>
            <p class="track-meta">To ${o.recipient_number}</p>
          </article>`;
      })
      .join("");
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
    results.innerHTML = `<p class="track-empty">Checking live status…</p>`;
    await lookup(phone);
    stopPoll();
    if (lastPhone) {
      pollTimer = setInterval(() => lookup(lastPhone, { silent: true }), 8000);
    }
  });
})();
