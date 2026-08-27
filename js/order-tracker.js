(function orderTrackerWidget() {
  if (document.body.classList.contains("dash-body") && !document.getElementById("order-tracker-root")) return;

  let root = document.getElementById("order-tracker-root");
  if (root?.querySelector("#track-fab")) return;

  if (!root) {
    root = document.createElement("div");
    root.id = "order-tracker-root";
    document.body.appendChild(root);
  }

  root.innerHTML = `
    <button class="track-fab" type="button" id="track-fab" aria-label="Track your order">Track order</button>
    <div class="track-panel" id="track-panel" hidden>
      <div class="track-panel-head">
        <div>
          <strong>Track transaction</strong>
          <p>Look up by order code or the recipient phone number used at checkout.</p>
        </div>
        <button class="track-close" type="button" id="track-close" aria-label="Close">×</button>
      </div>
      <div class="track-tabs" role="tablist">
        <button class="track-tab active" type="button" data-track-tab="code">Order ID</button>
        <button class="track-tab" type="button" data-track-tab="phone">Phone number</button>
      </div>
      <div class="track-form-area">
        <form class="track-form" id="track-form-code" data-track-form="code">
          <input id="track-code" placeholder="DL-ABC12345" autocomplete="off" required>
          <button class="btn btn-primary track-submit" type="submit">Track order</button>
        </form>
        <form class="track-form" id="track-form-phone" data-track-form="phone" hidden>
          <input id="track-phone" inputmode="tel" placeholder="024 123 4567" autocomplete="tel" required>
          <button class="btn btn-primary track-submit" type="submit">Check status</button>
        </form>
      </div>
      <p class="track-error" id="track-error" hidden></p>
      <div class="track-results" id="track-results"></div>
    </div>
  `;

  const fab = root.querySelector("#track-fab");
  const panel = root.querySelector("#track-panel");
  const formCode = root.querySelector("#track-form-code");
  const formPhone = root.querySelector("#track-form-phone");
  const codeInput = root.querySelector("#track-code");
  const phoneInput = root.querySelector("#track-phone");
  const errorEl = root.querySelector("#track-error");
  const results = root.querySelector("#track-results");
  let pollTimer = null;
  let pollMode = null;
  let pollValue = "";
  let activeTab = "code";

  function normalizeOrderCode(raw) {
    let code = String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!code) return "";
    if (/^[0-9A-F]{8}$/.test(code)) code = "DL" + code;
    if (/^DL[0-9A-F]{8}$/.test(code)) return "DL-" + code.slice(2);
    if (code.startsWith("DL") && code.length > 2) return "DL-" + code.slice(2);
    return code;
  }

  function openPanel() {
    panel.hidden = false;
    fab.classList.add("open");
    (activeTab === "code" ? codeInput : phoneInput).focus();
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

  function refundHelpUrl(orderCode) {
    // store.html and main pages both live at site root
    const base = "customer/refunds.html";
    return `${base}?order=${encodeURIComponent(orderCode || "")}`;
  }

  function setTab(tab) {
    activeTab = tab;
    root.querySelectorAll("[data-track-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.trackTab === tab);
    });
    formCode.hidden = tab !== "code";
    formPhone.hidden = tab !== "phone";
  }

  function statusClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return "is-delivered";
    if (s === "failed") return "is-failed";
    return "is-processing";
  }

  function statusEmoji(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return "🟢";
    if (s === "failed") return "🔴";
    return "🔵";
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

  function formatRetryWhen(iso) {
    if (!iso) return "";
    const when = formatOrderDateTime(iso);
    return `${when.date} · ${when.time}`;
  }

  function orderNeedsLivePoll(order) {
    const status = String(order?.delivery_status || "").toLowerCase();
    if (status === "processing" || status === "pending") return true;
    if (status === "failed" && Number(order?.retry_count || 0) > 0) return true;
    return false;
  }

  function timelineHtml(order) {
    const status = String(order.delivery_status || "").toLowerCase();
    const paid = String(order.payment_status).toLowerCase() === "paid";
    const delivered = status === "completed";
    const failed = status === "failed";
    const retried = Number(order.retry_count || 0) > 0;

    // Only completed steps are green. The current step is blue.
    // Future steps (including undelivered "Data delivered") stay uncolored.
    const steps = [
      {
        label: "Processing",
        state: paid || delivered || failed || retried ? "done" : "active",
      },
      {
        label: "Payment confirmed",
        state: paid || delivered || failed ? "done" : "pending",
      },
      {
        label: "Provider processing",
        state: delivered || retried ? "done" : paid && !failed ? "active" : failed ? "done" : "pending",
      },
    ];

    if (retried) {
      steps.push({
        label: failed ? "Retry failed" : delivered ? "Retry sent" : "Retry in progress",
        state: failed ? "failed" : delivered ? "done" : "active",
      });
    } else if (failed) {
      steps.push({ label: "Failed", state: "failed" });
    }

    if (!failed) {
      steps.push({ label: "Data delivered", state: delivered ? "done" : "pending" });
    }

    return `
      <ol class="track-timeline" aria-label="Order progress">
        ${steps
          .map(
            (step) => `
          <li class="track-step track-step--${step.state}">
            <span class="track-timeline-dot" aria-hidden="true"></span>
            <span>${step.label}</span>
          </li>`
          )
          .join("")}
      </ol>
    `;
  }

  function detailRow(label, value) {
    return `<div class="track-detail-row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function renderOrders(orders) {
    if (!orders.length) {
      results.innerHTML = `
        <p class="track-empty">No orders found.</p>
        <p class="track-empty">Double-check the order code or recipient number from checkout.</p>
      `;
      return;
    }
    results.innerHTML = `
      <p class="track-summary">${orders.length} order${orders.length === 1 ? "" : "s"} · live updates</p>
      ${orders
        .map((o) => {
          const when = formatOrderDateTime(o.created_at);
          const network = NETWORKS[o.network]?.name || o.network;
          const status = String(o.delivery_status || "processing");
          const retried = Number(o.retry_count || 0) > 0;
          let statusText = status === "completed" ? "Delivered" : status === "failed" ? "Failed" : "Processing";
          if (retried && status === "processing") statusText = "Retry in progress";
          const label = `${statusEmoji(status)} ${statusText}`;
          const paidLabel = String(o.payment_status).toLowerCase() === "paid" ? "Paid" : "Confirming payment";
          const canBuyAgain = !!o.package_id;
          const retryWhen = formatRetryWhen(o.last_retry_at);
          return `
          <article class="track-card ${statusClass(o.delivery_status)}">
            <div class="track-card-top">
              <div>
                <strong>${o.order_code || "Order"}</strong>
                <p class="track-meta" style="margin:4px 0 0">${escapeHtml(sourceLabel(o))}</p>
              </div>
              <span class="track-status">${label}</span>
            </div>
            <p class="track-bundle">${network} · ${o.gb} GB</p>
            <p class="track-hint">${escapeHtml(o.status_message || "")}</p>
            ${timelineHtml(o)}
            <div class="track-details">
              ${detailRow("Recipient", escapeHtml(o.recipient_number || "—"))}
              ${detailRow("Amount paid", formatCedi(o.amount_paid))}
              ${detailRow("Payment", `${paidLabel} · ${methodLabel(o.payment_method)}`)}
              ${retried ? detailRow("Retries", `${o.retry_count}${retryWhen ? ` · last ${retryWhen}` : ""}`) : ""}
              ${detailRow("Ordered", `${when.date} · ${when.time}`)}
            </div>
            <div class="track-actions">
              ${canBuyAgain ? `<button class="btn btn-primary btn-sm" type="button" data-buy-again="${o.package_id}" data-recipient="${escapeHtml(o.recipient_number || "")}" data-tier="${escapeHtml(o.pricing_tier || "retail")}" data-store="${o.agent_store_id || ""}">Buy again</button>` : ""}
              <a class="btn btn-ghost btn-sm" href="${refundHelpUrl(o.order_code)}">Get help</a>
              ${status === "failed" ? `<button class="btn btn-ghost btn-sm" type="button" data-support>Contact support</button>` : ""}
            </div>
          </article>`;
        })
        .join("")}
    `;
    results.querySelectorAll("[data-buy-again]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closePanel();
        window.DataLogsCustomer?.buyAgain?.({
          packageId: btn.dataset.buyAgain,
          recipient: btn.dataset.recipient,
          tier: btn.dataset.tier,
          storeId: btn.dataset.store || null,
        });
      });
    });
    results.querySelectorAll("[data-support]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prefix = document.body.classList.contains("store-body") || location.pathname.includes("/store") ? "" : "";
        window.location.href = `${prefix}contact.html`.replace(/^\//, "") || "contact.html";
      });
    });
  }

  async function lookupCode(code, { silent } = {}) {
    errorEl.hidden = true;
    const normalized = normalizeOrderCode(code);
    try {
      let rows = await trackByCode(normalized || code);
      rows = await refreshDelivery(rows, { mode: "code", value: normalized || code });
      renderOrders(rows || []);
      pollMode = "code";
      pollValue = normalized || code;
      startPoll("code", pollValue, rows);
      return rows;
    } catch (err) {
      if (!silent) {
        errorEl.hidden = false;
        errorEl.textContent = err.message || "Could not find that order.";
        results.innerHTML = "";
      }
      return [];
    }
  }

  async function lookupPhone(phone, { silent } = {}) {
    errorEl.hidden = true;
    try {
      let orders = await trackByPhone(phone);
      orders = await refreshDelivery(orders, { mode: "phone", value: phone });
      renderOrders(orders || []);
      pollMode = "phone";
      pollValue = phone;
      startPoll("phone", pollValue, orders);
      return orders;
    } catch (err) {
      if (!silent) {
        errorEl.hidden = false;
        errorEl.textContent = err.message || "Could not load orders.";
        results.innerHTML = "";
      }
      return [];
    }
  }

  async function refreshDelivery(orders, ctx = {}) {
    const list = Array.isArray(orders) ? orders : [];
    const pending = list.filter((o) => {
      const s = String(o.delivery_status || "").toLowerCase();
      const paid = String(o.payment_status || "").toLowerCase() === "paid";
      if (s === "processing" || s === "pending") return true;
      if (s === "failed" && paid) return true;
      return false;
    });
    if (!pending.length) return list;

    for (const order of pending.slice(0, 5)) {
      try {
        if (typeof window.DataLogsAPI?.syncOrderDelivery === "function") {
          await window.DataLogsAPI.syncOrderDelivery(order.order_code);
        } else {
          await syncDeliveryFallback(order.order_code);
        }
      } catch {
        /* keep showing current status if sync fails */
      }
    }

    if (ctx.mode === "phone" && ctx.value) return trackByPhone(ctx.value);
    if (ctx.mode === "code" && ctx.value) return trackByCode(ctx.value);
    if (list[0]?.order_code) return trackByCode(list[0].order_code);
    return list;
  }

  async function syncDeliveryFallback(orderCode) {
    const cfg = window.DATALOGS_CONFIG;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
    await fetch(`${cfg.supabaseUrl}/functions/v1/fulfill-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      body: JSON.stringify({ action: "sync_status", orderCode }),
    });
  }

  async function trackByPhone(phone) {
    if (typeof window.DataLogsAPI?.trackOrdersByPhone === "function") {
      return window.DataLogsAPI.trackOrdersByPhone(phone);
    }
    const client = window.DataLogsAPI?.client || trackingClient();
    if (!client) throw new Error("Tracking is unavailable right now.");
    const { data, error } = await client.rpc("track_orders_by_phone", { p_phone: phone });
    if (error) throw error;
    return data || [];
  }

  async function trackByCode(code) {
    if (typeof window.DataLogsAPI?.trackOrderByCode === "function") {
      return window.DataLogsAPI.trackOrderByCode(code);
    }
    const client = window.DataLogsAPI?.client || trackingClient();
    if (!client) throw new Error("Tracking is unavailable right now.");
    const { data, error } = await client.rpc("track_order_by_code", { p_code: code });
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

  root.querySelectorAll("[data-track-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.trackTab));
  });

  function startPoll(mode, value, orders) {
    stopPoll();
    if (!value) return;
    const needsPoll = !orders || !orders.length || orders.some(orderNeedsLivePoll);
    if (!needsPoll) return;
    pollTimer = setInterval(() => {
      if (mode === "phone") lookupPhone(value, { silent: true });
      else lookupCode(value, { silent: true });
    }, 8000);
  }

  formCode.addEventListener("submit", async (event) => {
    event.preventDefault();
    results.innerHTML = `<p class="track-empty">Looking up order…</p>`;
    await lookupCode(codeInput.value.trim());
    startPoll("code", pollValue);
  });

  formPhone.addEventListener("submit", async (event) => {
    event.preventDefault();
    results.innerHTML = `<p class="track-empty">Checking live status…</p>`;
    await lookupPhone(phoneInput.value.trim());
    startPoll("phone", pollValue);
  });

  const params = new URLSearchParams(window.location.search);
  const preCode = params.get("code") || params.get("order");
  if (preCode && document.body.dataset.page === "track") {
    codeInput.value = preCode;
    openPanel();
    lookupCode(preCode);
  }

  window.DataLogsTrack = {
    open: openPanel,
    close: closePanel,
    openWithCode(code) {
      setTab("code");
      const normalized = normalizeOrderCode(code) || code;
      codeInput.value = normalized;
      openPanel();
      lookupCode(normalized);
    },
  };
})();
