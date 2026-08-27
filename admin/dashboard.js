(async function adminDashboard() {
  const bootError = (message) => {
    const el = document.getElementById("overview-orders");
    if (el) {
      el.className = "empty-state";
      el.textContent = message;
    }
  };

  let profile;
  try {
    profile = await DataLogsAPI.requireProfile(["admin"], "../index.html");
  } catch (err) {
    bootError(err.message || "Could not load the admin session.");
    return;
  }
  if (!profile) return;

  try {
  const shell = document.getElementById("dash-shell");
  const titles = {
    overview: ["Overview", "Control center"],
    packages: ["Packages", "Retail & agent pricing"],
    orders: ["Orders", "Payments and delivery"],
    users: ["Users", "Tap a user for their full dashboard"],
    stores: ["Stores", "Agent mini storefronts"],
    flyer: ["Flyers", "Download a price poster for datalogs.shop"],
    api: ["API", "Keys, access, and live requests"],
    withdrawals: ["Withdrawals", "Approve or decline agent cash-outs"],
    refunds: ["Refunds", "Review and process customer refunds"],
    settings: ["Settings", "WhatsApp, support, and withdrawal threshold"],
  };

  let orderFilter = "all";
  let packageFilter = "mtn";
  let withdrawFilter = "pending";
  let refundFilter = "all";
  let withdrawalsCache = [];
  let refundsCache = [];
  let ordersCache = [];
  let usersCache = [];
  let packagesCache = [];
  let storesCache = [];
  let selectedUserId = null;

  document.getElementById("user-name").textContent = profile.full_name || "Admin";
  document.getElementById("user-email").textContent = profile.email || profile.authEmail || "";
  document.getElementById("user-avatar").textContent = (profile.full_name || "A").charAt(0).toUpperCase();

  function setCollapseIcon(collapsed) {
    var btn = document.getElementById("collapse-btn");
    if (!btn) return;
    btn.setAttribute("data-icon", collapsed ? "expand" : "collapse");
    window.DashIcons?.paint(btn);
  }

  document.getElementById("collapse-btn").addEventListener("click", () => {
    shell.classList.toggle("collapsed");
    setCollapseIcon(shell.classList.contains("collapsed"));
  });
  document.getElementById("mobile-menu-btn").addEventListener("click", () => shell.classList.toggle("mobile-open"));
  document.getElementById("dash-scrim")?.addEventListener("click", () => shell.classList.remove("mobile-open"));
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await DataLogsAPI.signOut();
    window.location.href = "../agent/auth.html";
  });

  document.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.panel === "users") selectedUserId = null;
      showPanel(btn.dataset.panel);
    });
  });

  function showPanel(id) {
    document.querySelectorAll("[data-panel]").forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === id));
    document.querySelectorAll("[data-panel-view]").forEach((panel) =>
      panel.classList.toggle("active", panel.dataset.panelView === id)
    );
    const [title, sub] = titles[id];
    document.getElementById("panel-title").textContent = title;
    document.getElementById("panel-sub").textContent = sub;
    shell.classList.remove("mobile-open");
    if (id === "users") {
      if (selectedUserId) {
        showUserDetail(selectedUserId);
      } else {
        showUsersList();
      }
    }
    if (id === "settings") loadSettingsForm();
    if (id === "api") loadApiConsole();
    if (id === "withdrawals") loadWithdrawals();
    if (id === "refunds") loadRefunds();
    if (id === "flyer") populateFlyerStoreSelect();
  }

  function showUsersList() {
    selectedUserId = null;
    document.getElementById("users-list-view").classList.remove("is-hidden");
    document.getElementById("user-detail-view").classList.add("is-hidden");
    document.getElementById("panel-title").textContent = titles.users[0];
    document.getElementById("panel-sub").textContent = titles.users[1];
  }

  function setUserDetailVisible() {
    document.getElementById("users-list-view").classList.add("is-hidden");
    document.getElementById("user-detail-view").classList.remove("is-hidden");
  }

  const form = document.getElementById("package-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("package-error");
    error.hidden = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const existing = await DataLogsAPI.fetchPackages({ includeInactive: true });
      const sameNetwork = existing.filter((p) => p.network === data.network && p.id !== data.id);
      const sortOrder = Math.round(Number(data.gb) * 10);
      await DataLogsAPI.upsertPackage({
        id: data.id || undefined,
        network: data.network,
        gb: data.gb,
        retail_price: data.retail_price,
        agent_price: data.agent_price,
        validity: "Non expiry",
        tag: null,
        sort_order: sortOrder || sameNetwork.length + 1,
        active: true,
      });
      form.reset();
      document.getElementById("package-id").value = "";
      await refreshAll();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save package.";
    }
  });

  document.getElementById("package-reset")?.addEventListener("click", () => {
    form?.reset();
    const idInput = document.getElementById("package-id");
    if (idInput) idInput.value = "";
  });

  async function loadSettingsForm() {
    try {
      const settings = await DataLogsAPI.getSiteSettings();
      document.getElementById("setting-wa").value = settings?.whatsapp_channel_url || "";
      document.getElementById("setting-support").value = settings?.support_contact || "";
      document.getElementById("setting-support-label").value = settings?.support_label || "Support";
      document.getElementById("setting-withdraw-threshold").value = settings?.withdrawal_threshold ?? 13;
      document.getElementById("setting-activation-enabled").checked = !!settings?.agent_activation_fee_enabled;
      document.getElementById("setting-activation-fee").value = settings?.agent_activation_fee ?? 0;
    } catch {
      /* keep empty */
    }
  }

  document.getElementById("settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("settings-error");
    const ok = document.getElementById("settings-ok");
    error.hidden = true;
    ok.hidden = true;
    try {
      await DataLogsAPI.updateSiteSettings({
        whatsappChannelUrl: document.getElementById("setting-wa").value,
        supportContact: document.getElementById("setting-support").value,
        supportLabel: document.getElementById("setting-support-label").value,
        withdrawalThreshold: document.getElementById("setting-withdraw-threshold").value,
        agentActivationFeeEnabled: document.getElementById("setting-activation-enabled").checked,
        agentActivationFee: document.getElementById("setting-activation-fee").value,
      });
      ok.hidden = false;
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save settings.";
    }
  });

  async function loadWithdrawals() {
    const body = document.getElementById("admin-withdraw-body");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="8">Loading…</td></tr>`;
    try {
      withdrawalsCache = await DataLogsAPI.getWithdrawals();
      renderAdminWithdrawals();
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8">${escapeHtml(err.message || "Could not load withdrawals.")}</td></tr>`;
    }
  }

  function renderAdminWithdrawals() {
    const body = document.getElementById("admin-withdraw-body");
    if (!body) return;
    const netName = { mtn: "MTN", telecel: "Telecel", airteltigo: "AT" };
    const list =
      withdrawFilter === "all"
        ? withdrawalsCache
        : withdrawalsCache.filter((w) => w.status === withdrawFilter);
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8">No ${withdrawFilter === "all" ? "" : withdrawFilter + " "}withdrawals.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((w) => {
        const agent = w.profiles || {};
        const agentLabel = escapeHtml(agent.full_name || agent.email || w.agent_id?.slice?.(0, 8) || "Agent");
        const actions =
          w.status === "pending"
            ? `<div class="hero-actions" style="gap:6px;flex-wrap:nowrap">
                <button class="btn btn-ok" type="button" data-wd-approve="${w.id}">Approve</button>
                <button class="btn btn-danger" type="button" data-wd-reject="${w.id}">Decline</button>
              </div>`
            : escapeHtml(w.note || "—");
        return `
        <tr>
          <td>${agentLabel}</td>
          <td>${formatCedi(w.amount)}</td>
          <td>${netName[w.network] || w.network || "—"}</td>
          <td>${escapeHtml(w.momo_number || "")}</td>
          <td>${escapeHtml(w.account_name || "—")}</td>
          <td>${escapeHtml(w.status)}</td>
          <td>${new Date(w.created_at).toLocaleString()}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
  }

  document.getElementById("withdraw-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-wfilter]");
    if (!btn) return;
    withdrawFilter = btn.dataset.wfilter;
    document.querySelectorAll("#withdraw-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderAdminWithdrawals();
  });

  document.getElementById("admin-withdraw-body")?.addEventListener("click", async (event) => {
    const approve = event.target.closest("[data-wd-approve]");
    const reject = event.target.closest("[data-wd-reject]");
    const id = approve?.dataset.wdApprove || reject?.dataset.wdReject;
    if (!id) return;
    const decision = approve ? "approved" : "rejected";
    const note =
      decision === "rejected" ? window.prompt("Optional note for declining this withdrawal:") || "" : "";
    try {
      await DataLogsAPI.reviewWithdrawal({ id, decision, note });
      await loadWithdrawals();
    } catch (err) {
      window.alert(err.message || "Could not update withdrawal.");
    }
  });

  async function loadRefunds() {
    const body = document.getElementById("admin-refunds-body");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="8">Loading…</td></tr>`;
    try {
      const [rows, stats] = await Promise.all([
        DataLogsAPI.adminListRefunds(refundFilter),
        DataLogsAPI.adminRefundStats(),
      ]);
      refundsCache = rows || [];
      paintRefundStats(stats);
      renderAdminRefunds();
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8">${escapeHtml(err.message || "Could not load refunds.")}</td></tr>`;
    }
  }

  function paintRefundStats(stats) {
    if (!stats) return;
    document.getElementById("refund-stat-total").textContent = String(stats.total_requests ?? 0);
    document.getElementById("refund-stat-pending").textContent = String(stats.pending ?? 0);
    document.getElementById("refund-stat-completed").textContent = String(stats.completed ?? 0);
    document.getElementById("refund-stat-amount").textContent = formatCedi(stats.total_refunded ?? 0);
  }

  function refundStatusLabel(s) {
    return window.DataLogsRefunds?.statusLabel?.(s) || s;
  }

  function refundReasonLabel(id) {
    return window.DataLogsRefunds?.reasonLabel?.(id) || id;
  }

  function renderAdminRefunds() {
    const body = document.getElementById("admin-refunds-body");
    if (!body) return;
    const list =
      refundFilter === "all" ? refundsCache : refundsCache.filter((r) => r.status === refundFilter);
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8">No ${refundFilter === "all" ? "" : refundFilter.replace(/_/g, " ") + " "}refunds.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((r) => {
        const reviewable = ["requested", "under_review", "approved"].includes(r.status);
        const canProcess = r.status === "approved";
        const actions = reviewable
          ? `<div class="hero-actions" style="gap:6px;flex-wrap:wrap">
              ${canProcess ? `<button class="btn btn-primary btn-sm" type="button" data-rf-process="${r.id}">Process</button>` : ""}
              ${r.status !== "approved" ? `<button class="btn btn-ok btn-sm" type="button" data-rf-approve="${r.id}">Approve</button>` : ""}
              <button class="btn btn-danger btn-sm" type="button" data-rf-reject="${r.id}">Reject</button>
              <button class="btn btn-ghost btn-sm" type="button" data-rf-view="${escapeHtml(r.refund_code)}">Details</button>
            </div>`
          : `<button class="btn btn-ghost btn-sm" type="button" data-rf-view="${escapeHtml(r.refund_code)}">Details</button>`;
        return `
        <tr>
          <td>${escapeHtml(r.refund_code)}${r.fraud_flag ? " 🚨" : ""}</td>
          <td>${escapeHtml(r.order_code)}</td>
          <td>${escapeHtml(r.customer_label || "—")}${r.agent_label && r.agent_label !== "—" ? `<br><span class="hint">${escapeHtml(r.agent_label)}</span>` : ""}</td>
          <td>${formatCedi(r.amount)}</td>
          <td>${escapeHtml(refundReasonLabel(r.reason))}</td>
          <td>${refundStatusLabel(r.status)}</td>
          <td>${new Date(r.created_at).toLocaleString()}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
  }

  document.getElementById("refund-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-rfilter]");
    if (!btn) return;
    refundFilter = btn.dataset.rfilter;
    document.querySelectorAll("#refund-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    loadRefunds();
  });

  document.getElementById("admin-refunds-body")?.addEventListener("click", async (event) => {
    const approve = event.target.closest("[data-rf-approve]");
    const reject = event.target.closest("[data-rf-reject]");
    const processBtn = event.target.closest("[data-rf-process]");
    const view = event.target.closest("[data-rf-view]");
    if (view) {
      showAdminRefundDetail(view.dataset.rfView);
      return;
    }
    const id = approve?.dataset.rfApprove || reject?.dataset.rfReject || processBtn?.dataset.rfProcess;
    if (!id) return;
    if (processBtn) {
      try {
        await window.DataLogsPay?.refund?.(id);
        window.alert("Refund processing started.");
        await loadRefunds();
      } catch (err) {
        window.alert(err.message || "Could not process refund.");
      }
      return;
    }
    const action = approve ? "approve" : "reject";
    const note =
      action === "reject"
        ? window.prompt("Optional note for rejecting this refund:") || ""
        : window.prompt("Optional admin note:") || "";
    try {
      await DataLogsAPI.adminReviewRefund(id, action, note);
      await loadRefunds();
    } catch (err) {
      window.alert(err.message || "Could not update refund.");
    }
  });

  async function showAdminRefundDetail(code) {
    try {
      const detail = await DataLogsAPI.getRefundDetail(code, null);
      const rf = detail.refund;
      const ord = detail.order;
      const events = detail.events || [];
      const timeline =
        window.DataLogsRefunds?.timelineHtml?.(events) ||
        events.map((e) => `${e.action} · ${e.created_at}`).join("\n");
      window.alert(
        [
          `${rf.refund_code} · ${rf.status}`,
          `Order: ${rf.order_code} · ${formatCedi(rf.amount)}`,
          `Reason: ${refundReasonLabel(rf.reason)}`,
          `Payment: ${ord?.payment_status || "—"} · Delivery: ${ord?.delivery_status || "—"}`,
          rf.support_ticket_code ? `Ticket: ${rf.support_ticket_code}` : "",
          rf.admin_note ? `Admin note: ${rf.admin_note}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (err) {
      window.alert(err.message || "Could not load refund details.");
    }
  }

  function withTimeout(promise, ms = 12000) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("This request took too long.")), ms)),
    ]);
  }

  function mapAdminPackage(row) {
    if (row && row.id && Number.isFinite(Number(row.retail ?? row.price)) && Number.isFinite(Number(row.agentPrice))) {
      return row;
    }
    if (typeof mapPackage === "function") return mapPackage(row);
    const agentPrice = Number(row.agent_price);
    return {
      id: row.id,
      network: row.network,
      gb: Number(row.gb),
      price: Number(row.retail_price),
      retail: Number(row.retail_price),
      agentPrice,
      defaultAgentPrice: agentPrice,
      customPriced: false,
      validity: row.validity,
      tag: row.tag || null,
      active: row.active,
      sort_order: row.sort_order,
    };
  }

  function filteredPackages() {
    if (packageFilter === "all") return packagesCache;
    return packagesCache.filter((p) => p.network === packageFilter);
  }

  function renderPackagesTable() {
    const body = document.getElementById("packages-body");
    if (!body) return;
    const list = filteredPackages();
    if (!packagesCache.length) {
      body.innerHTML = `<tr><td colspan="6">No packages yet.</td></tr>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="6">No packages for this network filter.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((p) => {
        const agent = Number(p.defaultAgentPrice ?? p.agentPrice);
        const retail = Number(p.retail);
        const payload = JSON.stringify(p).replace(/'/g, "&#39;");
        return `
      <tr data-package-row="${p.id}">
        <td>${NETWORKS[p.network]?.name || p.network}</td>
        <td>${p.gb}</td>
        <td>
          <input class="price-inline-input" type="number" min="0" step="0.01" data-pkg-retail="${p.id}" value="${retail}">
        </td>
        <td>
          <input class="price-inline-input" type="number" min="0" step="0.01" data-pkg-agent="${p.id}" value="${agent}">
        </td>
        <td>${p.validity || "Non expiry"}</td>
        <td>
          <button class="btn btn-ghost" type="button" data-edit-package='${payload}'>Edit</button>
          <button class="btn btn-ghost" type="button" data-delete-package="${p.id}">Delete</button>
        </td>
      </tr>`;
      })
      .join("");
  }

  function showLoadError(message) {
    const text = message || "Could not load dashboard data.";
    const overview = document.getElementById("overview-orders");
    if (overview) overview.innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
    const usersBody = document.getElementById("users-body");
    if (usersBody) usersBody.innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
    const packagesBody = document.getElementById("packages-body");
    if (packagesBody) packagesBody.innerHTML = `<tr><td colspan="6">${escapeHtml(text)}</td></tr>`;
    const ordersBody = document.getElementById("orders-body");
    if (ordersBody) ordersBody.innerHTML = `<tr><td colspan="13">${escapeHtml(text)}</td></tr>`;
    const storesBody = document.getElementById("stores-body");
    if (storesBody) storesBody.innerHTML = `<tr><td colspan="5">${escapeHtml(text)}</td></tr>`;
  }

  function paintPlatformStats(stats) {
    if (!stats) {
      const paid = ordersCache.filter((o) => o.payment_status === "paid");
      stats = {
        platform_earnings: paid.reduce((sum, o) => sum + Number(o.platform_margin || 0), 0),
        order_margins: paid.reduce((sum, o) => sum + Number(o.platform_margin || 0), 0),
        activation_fees: 0,
        refunds: 0,
        gross_customer_payments: paid.reduce((sum, o) => sum + Number(o.amount_paid || 0), 0),
        paid_orders: paid.length,
      };
    }
    const earnings = Number(stats.platform_earnings) || 0;
    const gross = Number(stats.gross_customer_payments) || 0;
    const margins = Number(stats.order_margins) || 0;
    const activation = Number(stats.activation_fees) || 0;
    const refunds = Number(stats.refunds) || 0;
    document.getElementById("stat-revenue").textContent = formatCedi(earnings);
    document.getElementById("stat-gross").textContent = formatCedi(gross);
    document.getElementById("stat-margin").textContent = formatCedi(margins);
    document.getElementById("stat-activation").textContent = formatCedi(activation);
    document.getElementById("stat-refunds").textContent = formatCedi(refunds);
    document.getElementById("stat-paid-orders").textContent = String(stats.paid_orders ?? 0);
  }

  function paintDashboard({ users, packages, orders, stores, platformStats }) {
    usersCache = users || [];
    packagesCache = packages || [];
    ordersCache = orders || [];
    storesCache = stores || [];
    const storeRows = storesCache;

    document.getElementById("stat-users").textContent = String(usersCache.length);
    document.getElementById("stat-packages").textContent = String(packagesCache.length);
    document.getElementById("stat-orders").textContent = String(ordersCache.length);
    paintPlatformStats(platformStats);

    const retryable = ordersCache.filter((o) => o.retryable && o.fail_reason === "low_balance");
    document.getElementById("stat-retry").textContent = String(retryable.length);
    renderAdminOrders();

    document.getElementById("overview-orders").innerHTML = ordersCache.length
      ? `<div class="table-wrap"><table class="orders-table"><thead><tr><th>Code</th><th>Source</th><th>Package</th><th>Paid</th><th>Platform</th><th>Delivery</th><th>Date</th><th>Time</th></tr></thead><tbody>${ordersCache
          .slice(0, 8)
          .map((o) => {
            const when = formatOrderDateTime(o.created_at);
            return `<tr><td>${o.order_code}</td><td>${orderSourceLabel(o)}</td><td>${NETWORKS[o.network]?.name || o.network} ${o.gb}GB</td><td>${formatCedi(o.amount_paid)}</td><td>${formatCedi(o.platform_margin || 0)}</td><td>${o.delivery_status}</td><td>${when.date}</td><td>${when.time}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<div class="empty-state">No orders yet.</div>`;

    renderPackagesTable();

    document.getElementById("users-body").innerHTML = usersCache.length
      ? usersCache
          .map((u) => {
            const blocked = u.blocked ? `<span class="badge-blocked">Blocked</span>` : "";
            const name = escapeHtml(u.full_name || u.email || "Unnamed user");
            const meta = [u.role, u.email, u.phone].filter(Boolean).map(escapeHtml).join(" · ");
            return `
        <article class="user-card" data-open-user="${u.id}">
          <div>
            <div class="user-card-name">${name} ${blocked}</div>
            <p class="user-card-meta">${meta || "No contact details"}</p>
          </div>
          <button class="btn btn-primary" type="button" data-open-user="${u.id}">Open dashboard</button>
        </article>`;
          })
          .join("")
      : `<div class="empty-state">No users yet.</div>`;

    document.getElementById("stores-body").innerHTML = storeRows.length
      ? storeRows
          .map((s) => {
            const agent = s.profiles ? s.profiles.full_name || s.profiles.email : "—";
            return `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td><a href="../store.html?s=${encodeURIComponent(s.slug)}" target="_blank" rel="noopener">${escapeHtml(s.slug)}</a></td>
          <td>${escapeHtml(agent)}</td>
          <td>${s.published ? "Yes" : "No"}</td>
          <td>${new Date(s.updated_at).toLocaleString()}</td>
        </tr>`;
          })
          .join("")
      : `<tr><td colspan="5">No stores yet.</td></tr>`;

    syncAdminFlyerPackages();
  }

  async function refreshAll() {
    let users = [];
    let packages = [];
    let orders = [];
    let stores = [];
    const rpcP = withTimeout(DataLogsAPI.adminDashboardData(), 8000);
    const statsP = withTimeout(DataLogsAPI.adminPlatformStats(), 8000);
    const usersP = withTimeout(DataLogsAPI.allUsers(), 8000);
    const packagesP = withTimeout(
      DataLogsAPI.fetchPackages({ includeInactive: true, applyCustomPrices: false }),
      8000
    );
    const ordersP = withTimeout(DataLogsAPI.allOrders(), 8000);
    const storesP = withTimeout(DataLogsAPI.allStores(), 8000);
    let platformStats = null;
    try {
      const bundle = await rpcP;
      users = bundle.users || [];
      packages = (bundle.packages || []).map(mapAdminPackage);
      orders = bundle.orders || [];
      stores = bundle.stores || [];
      try {
        platformStats = await statsP;
      } catch {
        platformStats = null;
      }
    } catch (bundleErr) {
      const results = await Promise.allSettled([usersP, packagesP, ordersP, storesP]);
      const [usersRes, packagesRes, ordersRes, storesRes] = results;
      if (usersRes.status === "fulfilled") users = usersRes.value || [];
      if (packagesRes.status === "fulfilled") packages = (packagesRes.value || []).map(mapAdminPackage);
      if (ordersRes.status === "fulfilled") orders = ordersRes.value || [];
      if (storesRes.status === "fulfilled") stores = storesRes.value || [];
      if (!users.length && !packages.length && !orders.length && !stores.length) {
        const failed = results.find((r) => r.status === "rejected");
        showLoadError(bundleErr.message || failed?.reason?.message || "Could not load dashboard data.");
        return;
      }
    }

    try {
      paintDashboard({ users, packages, orders, stores, platformStats });
    } catch (err) {
      showLoadError(err.message || "Could not render dashboard data.");
      return;
    }

    if (selectedUserId) {
      try {
        await showUserDetail(selectedUserId);
      } catch {
        /* list is already painted */
      }
    }

    DataLogsAPI.providerBalance()
      .then((bal) => {
        if (bal?.ok) document.getElementById("stat-provider").textContent = formatCedi(bal.balance || 0);
        else document.getElementById("stat-provider").textContent = "GH\u20B5 \u2014";
      })
      .catch(() => {
        document.getElementById("stat-provider").textContent = "GH\u20B5 \u2014";
      });
  }

  function canRetry(order) {
    return String(order.payment_status) === "paid" && String(order.delivery_status) === "failed";
  }

  function renderAdminOrders() {
    let list = ordersCache;
    if (orderFilter === "retry") list = list.filter(canRetry);
    if (orderFilter === "failed") list = list.filter((o) => o.delivery_status === "failed");
    document.getElementById("orders-body").innerHTML = list.length
      ? list
          .map((o) => {
            const buyer = o.profiles ? o.profiles.full_name || o.profiles.email : "Guest";
            const when = formatOrderDateTime(o.created_at);
            const retryBtn = canRetry(o)
              ? `<button class="btn btn-primary" type="button" data-retry-order="${o.id}">Retry API</button>
                 <button class="btn btn-ghost" type="button" data-mark-retried="${o.id}">Mark retried</button>`
              : "";
            const providerNote = o.fail_reason === "low_balance"
              ? "Low balance"
              : o.provider_status || o.provider_error || "—";
            return `
        <tr>
          <td>${o.order_code}</td>
          <td>${orderSourceLabel(o)}</td>
          <td>${escapeHtml(buyer)}</td>
          <td>${NETWORKS[o.network]?.name || o.network} ${o.gb} GB</td>
          <td>${escapeHtml(o.recipient_number)}</td>
          <td>${formatCedi(o.amount_paid)}</td>
          <td>${formatCedi(o.platform_margin || 0)}</td>
          <td>${o.payment_status}</td>
          <td>
            <select data-delivery="${o.id}">
              ${["pending", "processing", "delivered", "failed"]
                .map((s) => `<option value="${s}" ${o.delivery_status === s ? "selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </td>
          <td>${escapeHtml(providerNote)}</td>
          <td>${when.date}</td>
          <td>${when.time}</td>
          <td>${retryBtn}</td>
        </tr>`;
          })
          .join("")
      : `<tr><td colspan="13">No orders in this view.</td></tr>`;
  }

  async function showUserDetail(userId) {
    const user = usersCache.find((u) => u.id === userId);
    const root = document.getElementById("user-detail-root");
    if (!user) {
      showUsersList();
      return;
    }
    selectedUserId = userId;
    setUserDetailVisible();
    document.getElementById("panel-title").textContent = user.full_name || user.email || "User";
    document.getElementById("panel-sub").textContent = "Wallet, orders, access, and custom pricing";
    root.innerHTML = `<div class="panel-card"><p>Loading ${escapeHtml(user.full_name || user.email || "user")}…</p></div>`;

    let wallet;
    let txs;
    let orders;
    let customRows;
    try {
      [wallet, txs, orders, customRows] = await Promise.all([
        DataLogsAPI.getWallet(user.id).catch(() => ({ balance: 0 })),
        DataLogsAPI.getWalletTransactions(user.id).catch(() => []),
        DataLogsAPI.ordersForUser(user.id).catch(() => []),
        DataLogsAPI.getUserCustomPrices(user.id).catch(() => []),
      ]);
    } catch (err) {
      root.innerHTML = `<div class="panel-card"><button class="btn btn-ghost" type="button" id="user-back-btn">← All users</button><p class="error">${escapeHtml(err.message || "Could not load this user.")}</p></div>`;
      document.getElementById("user-back-btn").addEventListener("click", () => showUsersList());
      return;
    }
    const customMap = new Map((customRows || []).map((row) => [row.package_id, Number(row.agent_price)]));
    const isSelf = user.id === profile.id;
    const blocked = !!user.blocked;

    root.innerHTML = `
      <div class="panel-card">
        <div class="user-detail-head">
          <div>
            <button class="btn btn-ghost" type="button" id="user-back-btn">← All users</button>
          </div>
          ${blocked ? `<span class="badge-blocked">Blocked</span>` : ""}
        </div>
        <h3>${escapeHtml(user.full_name || "Unnamed user")}</h3>
        <div class="user-meta-grid">
          <div><span>Email</span><strong>${escapeHtml(user.email || "—")}</strong></div>
          <div><span>Phone</span><strong>${escapeHtml(user.phone || "—")}</strong></div>
          <div><span>Role</span><strong>${escapeHtml(user.role || "—")}</strong></div>
          <div><span>Joined</span><strong>${new Date(user.created_at).toLocaleDateString()}</strong></div>
        </div>
        <div class="user-actions">
          <label>Promote / change role
            <select id="user-role-select" ${isSelf ? "disabled" : ""}>
              ${["customer", "agent", "admin"]
                .map((r) => `<option value="${r}" ${user.role === r ? "selected" : ""}>${r}</option>`)
                .join("")}
            </select>
          </label>
          ${
            isSelf
              ? ""
              : `<button class="btn ${blocked ? "btn-ok" : "btn-danger"}" type="button" id="user-block-btn">${
                  blocked ? "Unblock account" : "Block account"
                }</button>`
          }
        </div>
        <p class="error" id="user-action-error" hidden></p>
      </div>

      <div class="panel-card">
        <h3>Wallet</h3>
        <div class="user-meta-grid">
          <div><span>Balance</span><strong id="user-wallet-balance">${formatCedi(wallet?.balance || 0)}</strong></div>
          <div><span>Transactions</span><strong>${txs.length}</strong></div>
        </div>
        <form class="form" id="user-credit-form">
          <div class="split" style="grid-template-columns:1fr 1fr;gap:12px">
            <label>Credit amount (GH\u20B5)
              <input type="number" name="amount" min="0.01" step="0.01" required placeholder="50.00">
            </label>
            <label>Note
              <input type="text" name="note" placeholder="Optional reason">
            </label>
          </div>
          <p class="error" id="user-credit-error" hidden></p>
          <button class="btn btn-primary" type="submit" style="margin-top:12px">Credit wallet</button>
        </form>
      </div>

      <div class="panel-card">
        <h3>Wallet transactions</h3>
        ${
          txs.length
            ? `<div class="table-wrap"><table class="orders-table"><thead><tr><th>Type</th><th>Amount</th><th>Balance</th><th>Note</th><th>When</th></tr></thead><tbody>${txs
                .map(
                  (t) => `<tr>
                    <td>${escapeHtml(t.type)}</td>
                    <td>${t.type === "credit" ? "+" : "-"}${formatCedi(t.amount)}</td>
                    <td>${formatCedi(t.balance_after)}</td>
                    <td>${escapeHtml(t.description || t.reference || "—")}</td>
                    <td>${new Date(t.created_at).toLocaleString()}</td>
                  </tr>`
                )
                .join("")}</tbody></table></div>`
            : `<div class="empty-state">No wallet activity yet.</div>`
        }
      </div>

      <div class="panel-card">
        <h3>All orders</h3>
        ${
          orders.length
            ? `<div class="table-wrap"><table class="orders-table"><thead><tr><th>Code</th><th>Package</th><th>Number</th><th>Paid</th><th>Delivery</th><th>When</th></tr></thead><tbody>${orders
                .map((o) => {
                  const when = formatOrderDateTime(o.created_at);
                  return `<tr>
                    <td>${escapeHtml(o.order_code)}</td>
                    <td>${NETWORKS[o.network]?.name || o.network} ${o.gb} GB</td>
                    <td>${escapeHtml(o.recipient_number)}</td>
                    <td>${formatCedi(o.amount_paid)}</td>
                    <td>${escapeHtml(o.delivery_status)}</td>
                    <td>${when.date} ${when.time}</td>
                  </tr>`;
                })
                .join("")}</tbody></table></div>`
            : `<div class="empty-state">No orders for this user.</div>`
        }
      </div>

      <div class="panel-card">
        <h3>Custom wholesale prices</h3>
        <p class="custom-price-hint">Leave a field empty to use the default agent price. These rates apply only to this user.</p>
        <p class="error" id="user-price-error" hidden></p>
        <p class="success" id="user-price-ok" hidden>Prices saved.</p>
        <div class="table-wrap">
          <table class="orders-table">
            <thead>
              <tr><th>Network</th><th>GB</th><th>Default</th><th>Custom price</th></tr>
            </thead>
            <tbody>
              ${packagesCache
                .map((p) => {
                  const custom = customMap.has(p.id) ? customMap.get(p.id) : "";
                  return `<tr>
                    <td>${NETWORKS[p.network]?.name || p.network}</td>
                    <td>${p.gb}</td>
                    <td>${formatCedi(p.defaultAgentPrice ?? p.agentPrice)}</td>
                    <td><input type="number" min="0" step="0.01" data-custom-price="${p.id}" value="${custom}" placeholder="Default"></td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <button class="btn btn-primary" type="button" id="user-save-prices" style="margin-top:14px">Save custom prices</button>
      </div>
    `;

    document.getElementById("user-back-btn").addEventListener("click", () => {
      showUsersList();
    });

    document.getElementById("user-role-select").addEventListener("change", async (event) => {
      const error = document.getElementById("user-action-error");
      error.hidden = true;
      try {
        await DataLogsAPI.updateUserRole(user.id, event.target.value);
        await refreshAll();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || "Could not update role.";
      }
    });

    const blockBtn = document.getElementById("user-block-btn");
    if (blockBtn) {
      blockBtn.addEventListener("click", async () => {
        const error = document.getElementById("user-action-error");
        error.hidden = true;
        const nextBlocked = !blocked;
        const label = nextBlocked ? "block" : "unblock";
        if (!confirm(`${label[0].toUpperCase() + label.slice(1)} ${user.full_name || user.email}?`)) return;
        try {
          await DataLogsAPI.adminSetBlocked(user.id, nextBlocked);
          await refreshAll();
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message || "Could not update account.";
        }
      });
    }

    document.getElementById("user-credit-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = document.getElementById("user-credit-error");
      error.hidden = true;
      const data = Object.fromEntries(new FormData(event.target).entries());
      try {
        await DataLogsAPI.adminCreditWallet(user.id, data.amount, data.note);
        event.target.reset();
        await refreshAll();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || "Could not credit wallet.";
      }
    });

    document.getElementById("user-save-prices").addEventListener("click", async () => {
      const error = document.getElementById("user-price-error");
      const ok = document.getElementById("user-price-ok");
      error.hidden = true;
      ok.hidden = true;
      try {
        const inputs = [...root.querySelectorAll("[data-custom-price]")];
        for (const input of inputs) {
          const raw = input.value.trim();
          const previous = customMap.has(input.dataset.customPrice)
            ? String(customMap.get(input.dataset.customPrice))
            : "";
          if (raw === previous) continue;
          await DataLogsAPI.adminSetCustomPrice(user.id, input.dataset.customPrice, raw === "" ? null : raw);
        }
        ok.hidden = false;
        await refreshAll();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || "Could not save prices.";
      }
    });
  }

  document.getElementById("admin-order-filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-afilter]");
    if (!btn) return;
    orderFilter = btn.dataset.afilter;
    document.querySelectorAll("#admin-order-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderAdminOrders();
  });

  document.getElementById("package-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pkgfilter]");
    if (!btn) return;
    packageFilter = btn.dataset.pkgfilter;
    document.querySelectorAll("#package-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    const percent = document.getElementById("markup-percent");
    if (percent) percent.value = "";
    const warn = document.getElementById("markup-warn");
    if (warn) warn.hidden = true;
    const error = document.getElementById("package-bulk-error");
    const ok = document.getElementById("package-bulk-ok");
    if (error) error.hidden = true;
    if (ok) ok.hidden = true;
    updateAdminMarkupCopy();
    renderPackagesTable();
  });

  function roundCedi(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function updateAdminMarkupCopy() {
    const el = document.getElementById("markup-info-copy");
    if (!el) return;
    const name = packageFilter === "all" ? "All" : NETWORKS[packageFilter]?.name || packageFilter;
    el.innerHTML = "Markup changes all Public and Agent prices for the selected network. Example: GH\u20B5 4.10 at +10% becomes GH\u20B5 4.51. After applying, click Save Prices. Markup only affects the currently selected network (" + name + ").";
  }

  function markupPercentValue() {
    const raw = String(document.getElementById("markup-percent")?.value || "")
      .replace("%", "")
      .replace(/\s/g, "")
      .trim();
    if (raw === "" || raw === "+" || raw === "-") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  document.getElementById("markup-apply")?.addEventListener("click", () => {
    const error = document.getElementById("package-bulk-error");
    const ok = document.getElementById("package-bulk-ok");
    const warn = document.getElementById("markup-warn");
    error.hidden = true;
    ok.hidden = true;
    warn.hidden = true;
    if (packageFilter === "all") {
      error.hidden = false;
      error.textContent = "Select MTN, AirtelTigo, or Telecel first. Markup does not run on All.";
      return;
    }
    const percent = markupPercentValue();
    if (percent == null) {
      error.hidden = false;
      error.textContent = "Enter a markup % such as +10 or -3.";
      return;
    }
    const rows = [...document.querySelectorAll("#packages-body [data-package-row]")];
    if (!rows.length) {
      error.hidden = false;
      error.textContent = `No ${NETWORKS[packageFilter]?.name || packageFilter} packages to mark up.`;
      return;
    }
    const rate = percent / 100;
    rows.forEach((row) => {
      const id = row.getAttribute("data-package-row");
      ["data-pkg-retail", "data-pkg-agent"].forEach((attr) => {
        const input = row.querySelector(`[${attr}="${id}"]`);
        if (!input) return;
        const current = Number(input.value);
        if (!Number.isFinite(current)) return;
        input.value = String(Math.max(0, roundCedi(current + current * rate)).toFixed(2));
      });
    });
    const name = NETWORKS[packageFilter]?.name || packageFilter;
    const signed = `${percent > 0 ? "+" : ""}${percent}`;
    document.getElementById("markup-percent").value = signed;
    warn.hidden = false;
    warn.textContent = `This will update all prices for ${name}. Click Save Prices to confirm.`;
  });

  document.getElementById("package-save-all")?.addEventListener("click", async () => {
    const error = document.getElementById("package-bulk-error");
    const ok = document.getElementById("package-bulk-ok");
    error.hidden = true;
    ok.hidden = true;
    const rows = [...document.querySelectorAll("#packages-body [data-package-row]")];
    if (!rows.length) {
      error.hidden = false;
      error.textContent = "No packages to save.";
      return;
    }
    const btn = document.getElementById("package-save-all");
    if (btn) btn.disabled = true;
    try {
      const payloads = rows.map((row) => {
        const id = row.getAttribute("data-package-row");
        const pkg = packagesCache.find((p) => p.id === id);
        if (!pkg) throw new Error("Package list is out of date. Refresh and try again.");
        const retail = Number(row.querySelector(`[data-pkg-retail="${id}"]`)?.value);
        const agent = Number(row.querySelector(`[data-pkg-agent="${id}"]`)?.value);
        if (Number.isNaN(retail) || Number.isNaN(agent) || retail < 0 || agent < 0) {
          throw new Error(`Invalid price for ${NETWORKS[pkg.network]?.name || pkg.network} ${pkg.gb}GB.`);
        }
        return {
          id: pkg.id,
          network: pkg.network,
          gb: pkg.gb,
          retail_price: retail,
          agent_price: agent,
          validity: pkg.validity || "Non expiry",
          tag: pkg.tag || null,
          sort_order: pkg.sortOrder ?? pkg.sort_order ?? Math.round(Number(pkg.gb) * 10),
          active: pkg.active !== false,
        };
      });
      await DataLogsAPI.upsertPackages(payloads);
      ok.hidden = false;
      ok.textContent = `Saved ${payloads.length} package price${payloads.length === 1 ? "" : "s"}.`;
      await refreshAll();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save package prices.";
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("packages-body").addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-package]");
    if (editBtn) {
      const p = JSON.parse(editBtn.getAttribute("data-edit-package"));
      form.id.value = p.id;
      form.network.value = p.network;
      form.gb.value = p.gb;
      form.retail_price.value = p.retail;
      form.agent_price.value = p.defaultAgentPrice ?? p.agentPrice;
      showPanel("packages");
      return;
    }
    const delBtn = event.target.closest("[data-delete-package]");
    if (delBtn && confirm("Delete this package?")) {
      await DataLogsAPI.deletePackage(delBtn.dataset.deletePackage);
      await refreshAll();
    }
  });

  document.getElementById("orders-body").addEventListener("click", async (event) => {
    const markBtn = event.target.closest("[data-mark-retried]");
    if (markBtn) {
      const error = document.getElementById("retry-error");
      error.hidden = true;
      markBtn.disabled = true;
      markBtn.textContent = "Saving…";
      try {
        await DataLogsAPI.recordOrderRetry(markBtn.dataset.markRetried);
        await refreshAll();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || "Could not mark order as retried.";
        markBtn.disabled = false;
        markBtn.textContent = "Mark retried";
      }
      return;
    }

    const btn = event.target.closest("[data-retry-order]");
    if (!btn) return;
    const error = document.getElementById("retry-error");
    error.hidden = true;
    btn.disabled = true;
    btn.textContent = "Retrying…";
    try {
      const result = await DataLogsAPI.fulfillOrder(btn.dataset.retryOrder, { retry: true });
      if (!result?.ok) {
        error.hidden = false;
        error.textContent = result?.message || "Retry failed.";
      }
      await refreshAll();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Retry failed.";
      btn.disabled = false;
      btn.textContent = "Retry API";
    }
  });

  document.getElementById("orders-body").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-delivery]");
    if (!select) return;
    await DataLogsAPI.updateOrder(select.dataset.delivery, { delivery_status: select.value });
    await refreshAll();
  });

  document.getElementById("users-body")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-open-user]");
    if (!btn) return;
    event.preventDefault();
    showUserDetail(btn.getAttribute("data-open-user"));
  });

  let apiKeysCache = [];
  let apiRequestsCache = [];
  let apiAgentsCache = [];
  let apiKeyFilter = "active";
  let apiReqFilter = "all";
  let apiSearch = "";

  async function loadApiConsole() {
    const keysBody = document.getElementById("admin-api-keys-body");
    const reqBody = document.getElementById("admin-api-requests-body");
    if (keysBody && !apiKeysCache.length) keysBody.innerHTML = `<tr><td colspan="6">Loading…</td></tr>`;
    if (reqBody && !apiRequestsCache.length) reqBody.innerHTML = `<tr><td colspan="7">Loading…</td></tr>`;
    try {
      const bundle = await withTimeout(DataLogsAPI.adminApiConsole(), 12000);
      const stats = bundle.stats || {};
      apiKeysCache = bundle.keys || [];
      apiRequestsCache = bundle.requests || [];
      apiAgentsCache = bundle.agents || [];
      document.getElementById("api-stat-keys").textContent = String(stats.active_keys || 0);
      document.getElementById("api-stat-users").textContent = String(stats.users_with_keys || 0);
      document.getElementById("api-stat-requests").textContent = String(stats.requests_24h || 0);
      document.getElementById("api-stat-errors").textContent = String(stats.errors_24h || 0);
      document.getElementById("api-stat-orders").textContent = String(stats.api_orders || 0);
      document.getElementById("api-stat-disabled").textContent = String(stats.disabled_users || 0);
      fillApiUserSelect();
      renderApiKeysTable();
      renderApiRequestsTable();
    } catch (err) {
      const message = err.message || "Could not load API data.";
      if (keysBody) keysBody.innerHTML = `<tr><td colspan="6">${escapeHtml(message)}</td></tr>`;
      if (reqBody) reqBody.innerHTML = `<tr><td colspan="7">${escapeHtml(message)}</td></tr>`;
    }
  }

  function fillApiUserSelect() {
    const select = document.getElementById("admin-api-user");
    if (!select) return;
    const current = select.value;
    const options = apiAgentsCache
      .filter((u) => !u.blocked)
      .map((u) => {
        const label = [u.full_name || u.email || "Unnamed", u.role, u.api_disabled ? "API off" : ""]
          .filter(Boolean)
          .join(" · ");
        return `<option value="${u.id}" ${u.api_disabled ? "disabled" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    select.innerHTML = `<option value="">Select an agent</option>${options}`;
    if (current && [...select.options].some((opt) => opt.value === current)) select.value = current;
  }

  function renderApiKeysTable() {
    const body = document.getElementById("admin-api-keys-body");
    if (!body) return;
    const q = apiSearch.trim().toLowerCase();
    let list = apiKeysCache;
    if (apiKeyFilter === "active") list = list.filter((k) => !k.revoked_at);
    if (apiKeyFilter === "revoked") list = list.filter((k) => k.revoked_at);
    if (q) {
      list = list.filter((k) =>
        [k.full_name, k.email, k.phone, k.name, k.key_prefix].some((v) => String(v || "").toLowerCase().includes(q))
      );
    }
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="6">No API keys in this view.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((k) => {
        const revoked = !!k.revoked_at;
        const disabled = !!k.api_disabled;
        const user = escapeHtml(k.full_name || k.email || "Unknown user");
        const meta = [k.email, k.role].filter(Boolean).map(escapeHtml).join(" · ");
        const used = k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never";
        const status = revoked
          ? `<span class="badge-blocked">Revoked</span>`
          : disabled
            ? `<span class="badge-blocked">API off</span>`
            : `<span class="badge-ok">Active</span>`;
        const actions = [
          revoked
            ? ""
            : `<button class="btn btn-danger" type="button" data-admin-revoke-key="${k.id}">Revoke</button>`,
          `<button class="btn btn-ghost" type="button" data-admin-api-toggle="${k.agent_id}" data-disabled="${disabled ? "0" : "1"}">${
            disabled ? "Enable API" : "Disable API"
          }</button>`,
        ]
          .filter(Boolean)
          .join(" ");
        return `<tr>
          <td><strong>${user}</strong><div class="user-card-meta">${meta}</div></td>
          <td>${escapeHtml(k.name || "Website")}</td>
          <td><code>${escapeHtml(k.key_prefix)}…</code></td>
          <td>${escapeHtml(used)}</td>
          <td>${status}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
  }

  function renderApiRequestsTable() {
    const body = document.getElementById("admin-api-requests-body");
    if (!body) return;
    let list = apiRequestsCache;
    if (apiReqFilter === "ok") list = list.filter((r) => r.ok);
    if (apiReqFilter === "error") list = list.filter((r) => !r.ok);
    if (apiReqFilter === "orders") list = list.filter((r) => r.method === "POST" && String(r.path || "").includes("order"));
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="7">No API requests in this view yet.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((r) => {
        const when = formatOrderDateTime(r.created_at);
        const user = escapeHtml(r.full_name || r.email || "—");
        const call = `${escapeHtml(r.method)} ${escapeHtml(r.path)}`;
        const statusClass = r.ok ? "badge-ok" : "badge-blocked";
        const detail = r.ok ? escapeHtml(r.ip || "") : escapeHtml(r.error_message || "Failed");
        return `<tr>
          <td>${when.date}<div class="user-card-meta">${when.time}</div></td>
          <td>${user}</td>
          <td><code>${call}</code></td>
          <td><span class="${statusClass}">${r.status_code}</span></td>
          <td>${escapeHtml(r.order_code || "—")}</td>
          <td>${r.duration_ms != null ? `${r.duration_ms} ms` : "—"}</td>
          <td>${detail || "—"}</td>
        </tr>`;
      })
      .join("");
  }

  document.getElementById("admin-api-key-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-kfilter]");
    if (!btn) return;
    apiKeyFilter = btn.dataset.kfilter;
    document.querySelectorAll("#admin-api-key-filters .filter-btn").forEach((el) => el.classList.toggle("active", el === btn));
    renderApiKeysTable();
  });

  document.getElementById("admin-api-req-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-rfilter]");
    if (!btn) return;
    apiReqFilter = btn.dataset.rfilter;
    document.querySelectorAll("#admin-api-req-filters .filter-btn").forEach((el) => el.classList.toggle("active", el === btn));
    renderApiRequestsTable();
  });

  document.getElementById("admin-api-search")?.addEventListener("input", (event) => {
    apiSearch = event.target.value || "";
    renderApiKeysTable();
  });

  document.getElementById("admin-api-refresh")?.addEventListener("click", () => loadApiConsole());

  document.getElementById("admin-api-key-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("admin-api-key-error");
    const reveal = document.getElementById("admin-api-key-reveal");
    error.hidden = true;
    reveal.hidden = true;
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!data.user_id) {
      error.hidden = false;
      error.textContent = "Select an agent first.";
      return;
    }
    try {
      const created = await DataLogsAPI.adminCreateUserApiKey(data.user_id, data.name);
      reveal.hidden = false;
      reveal.innerHTML = `
        <strong>Copy this key now. It will not be shown again.</strong>
        <code id="admin-new-api-key">${escapeHtml(created.key)}</code>
        <button class="btn btn-primary" type="button" id="admin-copy-api-key">Copy key</button>`;
      document.getElementById("admin-copy-api-key").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(created.key);
          document.getElementById("admin-copy-api-key").textContent = "Copied";
        } catch {
          document.getElementById("admin-new-api-key").focus();
        }
      });
      await loadApiConsole();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not create key.";
    }
  });

  document.getElementById("admin-api-keys-body")?.addEventListener("click", async (event) => {
    const revokeBtn = event.target.closest("[data-admin-revoke-key]");
    if (revokeBtn) {
      if (!confirm("Revoke this API key? Sites using it will stop working.")) return;
      try {
        await DataLogsAPI.adminRevokeApiKey(revokeBtn.dataset.adminRevokeKey);
        await loadApiConsole();
      } catch (err) {
        alert(err.message || "Could not revoke key.");
      }
      return;
    }
    const toggleBtn = event.target.closest("[data-admin-api-toggle]");
    if (!toggleBtn) return;
    const disable = toggleBtn.dataset.disabled === "1";
    const message = disable
      ? "Disable API access for this user? All of their active keys will be revoked."
      : "Enable API access for this user? They can create new keys afterwards.";
    if (!confirm(message)) return;
    try {
      await DataLogsAPI.adminSetApiDisabled(toggleBtn.dataset.adminApiToggle, disable);
      await loadApiConsole();
    } catch (err) {
      alert(err.message || "Could not update API access.");
    }
  });

  loadSettingsForm();

  let adminFlyerStyle = "shop";
  let adminFlyerPackages = [];
  let adminFlyerPackageSearch = "";
  const adminFlyerShareMessage = document.getElementById("flyer-share-message");
  const adminFlyerSearch = document.getElementById("flyer-search");

  function mainSiteLink() {
    const base = (window.DATALOGS_CONFIG?.siteUrl || "https://datalogs.shop").replace(/\/$/, "");
    return `${base}/packages.html`;
  }

  function syncAdminFlyerPackages() {
    adminFlyerPackages = packagesCache.slice();
    renderAdminFlyerPreview().catch(() => {});
  }

  function prettyPhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("0")) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return String(raw || "").trim();
  }

  function intlPhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("233")) {
      return `+233 (0) ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }
    return prettyPhone(raw);
  }

  function adminFlyerPackagesList() {
    const q = adminFlyerPackageSearch.trim().toLowerCase();
    return adminFlyerPackages
      .filter((p) => p.active !== false)
      .map((p) => {
        const retail = roundCedi(Number(p.retail ?? p.price));
        return { network: p.network, gb: p.gb, price: Number.isFinite(retail) ? retail : 0 };
      })
      .filter((p) => p.price > 0)
      .filter((p) => {
        if (!q) return true;
        const net =
          p.network === "mtn"
            ? "mtn"
            : p.network === "airteltigo"
              ? "airteltigo airtel tigo at"
              : "telecel vodafone";
        const hay = `${net} ${p.gb}gb ${p.price}`.toLowerCase();
        return hay.includes(q);
      });
  }

  function adminFlyerShareText() {
    const custom = adminFlyerShareMessage?.value?.trim();
    if (custom) return custom;
    return window.DataLogsFlyer?.buildShareMessage?.(adminFlyerPayload()) || "";
  }

  function updateAdminFlyerShareMessage() {
    if (!adminFlyerShareMessage || !window.DataLogsFlyer?.buildShareMessage) return;
    adminFlyerShareMessage.value = DataLogsFlyer.buildShareMessage(adminFlyerPayload());
  }

  function adminFlyerPayload() {
    const phoneInput = document.getElementById("flyer-phone");
    const hoursInput = document.getElementById("flyer-hours");
    const nameInput = document.getElementById("flyer-name");
    const taglineInput = document.getElementById("flyer-tagline");
    const accentId = document.documentElement.getAttribute("data-accent") || window.DataLogsTheme?.currentAccent?.() || "sea";
    const accentHex =
      window.DataLogsTheme?.ACCENTS?.find((a) => a.id === accentId)?.hex ||
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#2ec8e6";
    return {
      name: nameInput?.value?.trim() || "DataLogs GH",
      tagline: taglineInput?.value?.trim() || "Data for Ghana. In one tap.",
      phone: prettyPhone(phoneInput?.value || ""),
      phoneIntl: intlPhone(phoneInput?.value || ""),
      hours: hoursInput?.value || "8am - 9pm Each day",
      url: mainSiteLink(),
      packages: adminFlyerPackagesList(),
      accent: accentHex,
    };
  }

  async function initAdminFlyer() {
    adminFlyerPackages = packagesCache.slice();
    try {
      const settings = await DataLogsAPI.getSiteSettings();
      const phoneInput = document.getElementById("flyer-phone");
      if (phoneInput && !phoneInput.value.trim() && settings?.support_contact) {
        phoneInput.value = settings.support_contact;
      }
    } catch {
      /* optional */
    }
    renderAdminFlyerPreview().catch(() => {});
  }

  async function renderAdminFlyerPreview() {
    const error = document.getElementById("flyer-error");
    const hint = document.getElementById("flyer-url-hint");
    const canvas = document.getElementById("flyer-canvas");
    if (!canvas || !window.DataLogsFlyer) return;
    error.hidden = true;
    if (!adminFlyerPackagesList().length) {
      error.hidden = false;
      error.textContent = "Add active packages with retail prices first.";
      return;
    }
    const data = adminFlyerPayload();
    if (hint) hint.textContent = `Caption: ${data.url.replace(/^https?:\/\//, "")} · MoMo · 1–5 min delivery`;
    try {
      await DataLogsFlyer.render(canvas, adminFlyerStyle, data);
      updateAdminFlyerShareMessage();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not draw the flyer.";
    }
  }

  document.getElementById("flyer-preview-btn")?.addEventListener("click", () => renderAdminFlyerPreview());
  ["flyer-phone", "flyer-hours", "flyer-name", "flyer-tagline"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => renderAdminFlyerPreview());
  });
  adminFlyerSearch?.addEventListener("input", () => {
    adminFlyerPackageSearch = adminFlyerSearch.value || "";
    renderAdminFlyerPreview();
  });

  function adminFlyerShareFeedback(errorEl, mode) {
    if (!errorEl || !mode) return;
    errorEl.hidden = false;
    errorEl.style.color = "var(--accent, #22c55e)";
    if (mode === "shared") {
      errorEl.textContent = "Shared the flyer image with your message. Choose WhatsApp (or any app) in the share sheet.";
    } else if (mode === "shared-file-text-copied") {
      errorEl.textContent =
        "Flyer image shared. Message is copied — paste it in the same chat if the caption did not appear.";
    } else if (mode === "clipboard-whatsapp") {
      errorEl.textContent =
        "WhatsApp has your message. Paste in the chat to add the flyer image too.";
    } else if (mode === "clipboard") {
      errorEl.textContent = "Flyer image and message copied. Paste into a chat to send both.";
    } else if (mode === "copy-download-whatsapp") {
      errorEl.textContent =
        "Message opened in WhatsApp and flyer downloaded. Attach the JPG in the chat to send both.";
    } else if (mode === "copy-download") {
      errorEl.textContent =
        "Message copied and flyer downloaded. Attach the JPG when you send the message.";
    }
  }

  document.getElementById("flyer-share-btn")?.addEventListener("click", async () => {
    const canvas = document.getElementById("flyer-canvas");
    const error = document.getElementById("flyer-error");
    const shareBtn = document.getElementById("flyer-share-btn");
    error.hidden = true;
    if (!adminFlyerPackagesList().length || !canvas || !window.DataLogsFlyer?.share) {
      error.hidden = false;
      error.textContent = "Add active packages with retail prices first.";
      return;
    }
    try {
      shareBtn.disabled = true;
      await renderAdminFlyerPreview();
      const mode = await DataLogsFlyer.share(
        canvas,
        adminFlyerPayload(),
        `datalogs-${adminFlyerStyle}-flyer.jpg`,
        adminFlyerShareText()
      );
      adminFlyerShareFeedback(error, mode);
    } catch (err) {
      if (err?.name !== "AbortError") {
        error.hidden = false;
        error.textContent = err.message || "Could not share the flyer.";
      }
    } finally {
      shareBtn.disabled = false;
    }
  });

  document.getElementById("flyer-whatsapp-btn")?.addEventListener("click", async () => {
    const canvas = document.getElementById("flyer-canvas");
    const error = document.getElementById("flyer-error");
    error.hidden = true;
    if (!adminFlyerPackagesList().length) {
      error.hidden = false;
      error.textContent = "Add active packages with retail prices first.";
      return;
    }
    try {
      await renderAdminFlyerPreview();
      const mode = await DataLogsFlyer.shareWhatsApp(
        canvas,
        adminFlyerShareText(),
        `datalogs-${adminFlyerStyle}-flyer.jpg`
      );
      adminFlyerShareFeedback(error, mode);
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not open WhatsApp share.";
    }
  });

  document.getElementById("flyer-copy-message-btn")?.addEventListener("click", async () => {
    const error = document.getElementById("flyer-error");
    const copyBtn = document.getElementById("flyer-copy-message-btn");
    error.hidden = true;
    try {
      copyBtn.disabled = true;
      updateAdminFlyerShareMessage();
      await DataLogsFlyer.copyShareMessage(adminFlyerShareText());
      error.hidden = false;
      error.textContent = "Share message copied.";
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not copy message.";
    } finally {
      copyBtn.disabled = false;
    }
  });

  document.getElementById("flyer-styles")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-flyer-style]");
    if (!btn) return;
    adminFlyerStyle = btn.dataset.flyerStyle;
    document.querySelectorAll("#flyer-styles .flyer-style").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderAdminFlyerPreview();
  });

  document.getElementById("flyer-download-btn")?.addEventListener("click", async () => {
    const canvas = document.getElementById("flyer-canvas");
    const error = document.getElementById("flyer-error");
    error.hidden = true;
    if (!adminFlyerPackagesList().length) {
      error.hidden = false;
      error.textContent = "Add active packages with retail prices first.";
      return;
    }
    try {
      await renderAdminFlyerPreview();
      await DataLogsFlyer.download(canvas, `datalogs-${adminFlyerStyle}-flyer.jpg`);
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not download the flyer.";
    }
  });

  document.getElementById("reset-platform-revenue")?.addEventListener("click", async () => {
    const msg = document.getElementById("reset-platform-revenue-msg");
    if (msg) msg.hidden = true;
    if (!window.confirm("Clear all logged platform earnings? Orders and payments stay — only the earnings log resets to GH₵ 0.")) {
      return;
    }
    try {
      await DataLogsAPI.resetPlatformRevenue();
      ordersCache = ordersCache.map((o) => ({ ...o, platform_margin: 0 }));
      paintPlatformStats({
        platform_earnings: 0,
        order_margins: 0,
        activation_fees: 0,
        refunds: 0,
        gross_customer_payments: ordersCache
          .filter((o) => o.payment_status === "paid")
          .reduce((sum, o) => sum + Number(o.amount_paid || 0), 0),
        paid_orders: ordersCache.filter((o) => o.payment_status === "paid").length,
      });
      renderAdminOrders();
      if (msg) {
        msg.hidden = false;
        msg.style.color = "var(--success)";
        msg.textContent = "Earnings log reset. Platform earnings are now GH₵ 0.00. New orders will log margin again.";
      }
    } catch (err) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "var(--danger)";
        msg.textContent = err.message || "Could not reset earnings. Apply the platform revenue SQL first.";
      }
    }
  });

  await refreshAll();
  await initAdminFlyer();
  if (window.DataLogsNotify) DataLogsNotify.init("#dash-topbar-end");

  document.getElementById("announce-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("announce-error");
    const ok = document.getElementById("announce-ok");
    if (error) error.hidden = true;
    if (ok) ok.hidden = true;
    try {
      await DataLogsAPI.adminCreateAnnouncement({
        title: document.getElementById("announce-title").value.trim(),
        body: document.getElementById("announce-body").value.trim(),
        audience: document.getElementById("announce-audience").value,
        priority: document.getElementById("announce-priority").value,
      });
      event.target.reset();
      if (ok) ok.hidden = false;
    } catch (err) {
      if (error) {
        error.hidden = false;
        error.textContent = err.message || "Could not publish announcement.";
      }
    }
  });
  } catch (err) {
    bootError(err.message || "Admin dashboard failed to start.");
  }
})();
