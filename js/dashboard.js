(async function dashboard() {
  const profile = await DataLogsAPI.requireProfile(["agent", "admin"], "auth.html");
  if (!profile) return;
  if (profile.role === "admin") {
    window.location.href = "../admin/dashboard.html";
    return;
  }

  const shell = document.getElementById("dash-shell");
  const titles = {
    overview: ["Overview", "Your agent snapshot"],
    store: ["Mini store", "Your unique storefront"],
    pricing: ["Store pricing", "Base + your profit = sell price"],
    wholesale: ["Buy wholesale", "Subsidized agent rates"],
    orders: ["Orders", "Store sales & wholesale"],
    customers: ["Customers", "People who bought from your store"],
    wallet: ["My Wallet", "Commissions and balance"],
    withdrawal: ["Withdrawal", "Cash out to MoMo"],
    account: ["Account", "Profile details"],
  };

  let wholesaleFilter = "all";
  let pricingFilter = "all";
  let ordersFilter = "all";
  let packages = [];
  let priceMap = new Map();
  let storeCache = null;

  document.getElementById("user-name").textContent = profile.full_name || "Agent";
  document.getElementById("user-email").textContent = profile.email || profile.authEmail || "";
  document.getElementById("user-avatar").textContent = (profile.full_name || "A").trim().charAt(0).toUpperCase();
  document.getElementById("account-name").value = profile.full_name || "";
  document.getElementById("account-email").value = profile.email || profile.authEmail || "";
  document.getElementById("account-phone").value = profile.phone || "";

  document.getElementById("collapse-btn").addEventListener("click", () => {
    shell.classList.toggle("collapsed");
    const collapsed = shell.classList.contains("collapsed");
    document.getElementById("collapse-btn").textContent = collapsed ? "»" : "«";
    localStorage.setItem("datalogs_sidebar", collapsed ? "1" : "0");
  });

  if (localStorage.getItem("datalogs_sidebar") === "1" && window.innerWidth > 980) {
    shell.classList.add("collapsed");
    document.getElementById("collapse-btn").textContent = "»";
  }

  document.getElementById("mobile-menu-btn").addEventListener("click", () => {
    shell.classList.toggle("mobile-open");
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await DataLogsAPI.signOut();
    window.location.href = "auth.html";
  });

  document.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  });

  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.goto));
  });

  function showPanel(id) {
    document.querySelectorAll("[data-panel]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.panel === id);
    });
    document.querySelectorAll("[data-panel-view]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panelView === id);
    });
    const [title, sub] = titles[id] || ["Dashboard", ""];
    document.getElementById("panel-title").textContent = title;
    document.getElementById("panel-sub").textContent = sub;
    shell.classList.remove("mobile-open");
    if (id === "wholesale") renderWholesale();
    if (id === "pricing") renderPricing();
    if (id === "orders") renderOrders();
    if (id === "customers") renderCustomers();
    if (id === "wallet") renderWallet();
    if (id === "withdrawal") renderWithdrawals();
    if (id === "overview") renderOverview();
  }

  const storeForm = document.getElementById("store-form");
  storeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(storeForm);
    const networks = form.getAll("networks");
    if (!networks.length) {
      showStoreMessage("error", "Pick at least one network.");
      return;
    }
    try {
      const store = await DataLogsAPI.saveStore(profile.id, {
        name: form.get("name"),
        slug: form.get("slug"),
        tagline: form.get("tagline"),
        networks,
        published: form.get("published") === "on",
      });
      storeForm.slug.value = store.slug;
      showStoreMessage("success", "Store saved. Your share link is ready.");
      await refreshStoreUI();
      await renderOverview();
    } catch (err) {
      showStoreMessage("error", err.message || "Could not save store.");
    }
  });

  storeForm.name.addEventListener("input", () => {
    if (!storeForm.dataset.slugTouched) {
      storeForm.slug.value = slugify(storeForm.name.value);
    }
  });
  storeForm.slug.addEventListener("input", () => {
    storeForm.dataset.slugTouched = "1";
  });

  document.getElementById("copy-link-btn").addEventListener("click", async () => {
    const input = document.getElementById("share-url");
    if (!input.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      document.getElementById("copy-link-btn").textContent = "Copied";
      setTimeout(() => {
        document.getElementById("copy-link-btn").textContent = "Copy link";
      }, 1400);
    } catch {
      input.select();
      document.execCommand("copy");
    }
  });

  document.getElementById("wholesale-filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-wfilter]");
    if (!btn) return;
    wholesaleFilter = btn.dataset.wfilter;
    document.querySelectorAll("#wholesale-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderWholesale();
  });

  document.getElementById("pricing-filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pfilter]");
    if (!btn) return;
    pricingFilter = btn.dataset.pfilter;
    document.querySelectorAll("#pricing-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderPricing();
  });

  document.getElementById("pricing-body").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-save-profit]");
    if (!btn) return;
    const packageId = btn.dataset.saveProfit;
    const input = document.querySelector(`[data-profit-input="${packageId}"]`);
    const error = document.getElementById("pricing-error");
    const success = document.getElementById("pricing-success");
    error.hidden = true;
    success.hidden = true;
    try {
      const row = await DataLogsAPI.setAgentPackageProfit(packageId, input.value);
      priceMap.set(packageId, Number(row.profit));
      success.hidden = false;
      success.textContent = "Price saved. Your store will sell at base + profit.";
      renderPricing();
      await renderOverview();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save profit.";
    }
  });

  document.getElementById("pricing-body").addEventListener("input", (event) => {
    const input = event.target.closest("[data-profit-input]");
    if (!input) return;
    const packageId = input.dataset.profitInput;
    const pkg = packages.find((p) => p.id === packageId);
    if (!pkg) return;
    const sellEl = document.querySelector(`[data-sell-preview="${packageId}"]`);
    if (sellEl) {
      const profit = Math.max(0, Number(input.value) || 0);
      sellEl.textContent = formatCedi(pkg.agentPrice + profit);
    }
  });

  document.getElementById("orders-filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-ofilter]");
    if (!btn) return;
    ordersFilter = btn.dataset.ofilter;
    document.querySelectorAll("#orders-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderOrders();
  });

  document.getElementById("withdraw-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("withdraw-error");
    const success = document.getElementById("withdraw-success");
    error.hidden = true;
    success.hidden = true;
    const form = new FormData(event.target);
    try {
      await DataLogsAPI.requestWithdrawal({
        amount: form.get("amount"),
        momoNumber: form.get("momo"),
        accountName: form.get("account_name"),
      });
      success.hidden = false;
      success.textContent = "Withdrawal submitted. Admins will process it.";
      event.target.reset();
      await renderWithdrawals();
      await renderWallet();
      await renderOverview();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not submit withdrawal.";
    }
  });

  window.addEventListener("datalogs:order-placed", () => {
    renderOverview();
    renderOrders();
    renderCustomers();
    renderWallet();
  });

  function showStoreMessage(type, message) {
    const error = document.getElementById("store-error");
    const success = document.getElementById("store-success");
    error.hidden = type !== "error";
    success.hidden = type !== "success";
    if (type === "error") error.textContent = message;
    if (type === "success") success.textContent = message;
  }

  async function refreshStoreUI() {
    storeCache = await DataLogsAPI.getStoreByAgent(profile.id);
    const openBtn = document.getElementById("open-store-btn");
    if (!storeCache) {
      document.getElementById("share-url").value = "";
      openBtn.href = "#";
      return;
    }
    storeForm.name.value = storeCache.name;
    storeForm.slug.value = storeCache.slug;
    storeForm.tagline.value = storeCache.tagline || "";
    storeForm.published.checked = storeCache.published;
    storeForm.querySelectorAll("[name=networks]").forEach((box) => {
      box.checked = (storeCache.networks || []).includes(box.value);
    });
    const url = DataLogsAPI.storePublicUrl(storeCache.slug);
    document.getElementById("share-url").value = url;
    document.getElementById("preview-link").href = url;
    openBtn.href = url;
  }

  function isStoreSale(order) {
    return !!order.agent_store_id && order.pricing_tier === "retail";
  }

  function isWholesale(order) {
    return order.pricing_tier === "agent" && order.buyer_id === profile.id;
  }

  async function loadVisibleOrders() {
    const orders = await DataLogsAPI.myOrders();
    return orders.filter((o) => isStoreSale(o) || isWholesale(o));
  }

  async function renderOverview() {
    const store = storeCache || (await DataLogsAPI.getStoreByAgent(profile.id));
    storeCache = store;
    const orders = await loadVisibleOrders();
    const storeSales = orders.filter(isStoreSale);
    const wallet = await DataLogsAPI.getWallet();
    const txs = await DataLogsAPI.getWalletTransactions();
    const profitEarned = txs
      .filter((t) => t.type === "credit")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    document.getElementById("stat-store").textContent = store ? (store.published ? "Live" : "Draft") : "Not set";
    document.getElementById("stat-orders").textContent = String(orders.length);
    document.getElementById("stat-profit").textContent = formatCedi(profitEarned);
    document.getElementById("stat-saved").textContent = formatCedi(wallet?.balance || 0);

    const box = document.getElementById("overview-orders");
    if (!orders.length) {
      box.className = "empty-state";
      box.textContent = "No orders yet. Set store prices, share your link, then sales profit lands in your wallet.";
      return;
    }
    box.className = "";
    box.innerHTML = `
      <div class="table-wrap">
        <table class="orders-table">
          <thead><tr><th>Type</th><th>Package</th><th>Number</th><th>Paid</th><th>When</th></tr></thead>
          <tbody>
            ${orders
              .slice(0, 5)
              .map(
                (o) => `
              <tr>
                <td>${isStoreSale(o) ? "Store" : "Wholesale"}</td>
                <td>${NETWORKS[o.network]?.name || o.network} ${o.gb} GB</td>
                <td>${o.recipient_number}</td>
                <td>${formatCedi(o.amount_paid)}</td>
                <td>${new Date(o.created_at).toLocaleString()}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:10px">Store sales: ${storeSales.length} · Total profit credited: ${formatCedi(profitEarned)} · Withdrawable now: ${formatCedi(wallet?.balance || 0)}</p>`;
  }

  function renderPricing() {
    const list = packagesFor(pricingFilter, packages);
    const body = document.getElementById("pricing-body");
    body.innerHTML = list
      .map((item) => {
        const profit = priceMap.has(item.id) ? Number(priceMap.get(item.id)) : "";
        const sell = profit === "" ? item.agentPrice : item.agentPrice + Number(profit || 0);
        return `
          <tr>
            <td>${NETWORKS[item.network]?.name || item.network}</td>
            <td>${item.gb} GB</td>
            <td>${formatCedi(item.agentPrice)}</td>
            <td>
              <input data-profit-input="${item.id}" type="number" min="0" step="0.01" value="${profit}" placeholder="0.00" style="width:110px;background:#101010;border:1px solid var(--line);color:var(--text);border-radius:10px;padding:8px 10px">
            </td>
            <td data-sell-preview="${item.id}">${formatCedi(sell)}</td>
            <td><button class="btn btn-primary" type="button" data-save-profit="${item.id}">Save</button></td>
          </tr>`;
      })
      .join("");
  }

  function renderWholesale() {
    const list = packagesFor(wholesaleFilter, packages);
    document.getElementById("wholesale-grid").innerHTML = list
      .map((item) => {
        const saved = item.retail - item.agentPrice;
        return `
          <button class="wholesale-card ${item.network}" type="button" data-buy="${item.id}" data-tier="agent">
            <div class="pill" style="background:rgba(0,0,0,0.12);color:inherit">${NETWORKS[item.network].name}</div>
            <div class="gb">${item.gb}<span style="font-size:1rem"> GB</span></div>
            <div class="price-row">
              <span class="now">${formatCedi(item.agentPrice)}</span>
              <span class="was">${formatCedi(item.retail)}</span>
            </div>
            <span class="save-badge">Save ${formatCedi(saved)}</span>
          </button>`;
      })
      .join("");
  }

  async function renderOrders() {
    let orders = await loadVisibleOrders();
    if (ordersFilter === "store") orders = orders.filter(isStoreSale);
    if (ordersFilter === "wholesale") orders = orders.filter(isWholesale);

    const body = document.getElementById("orders-body");
    const empty = document.getElementById("orders-empty");
    if (!orders.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = orders
      .map(
        (o) => `
      <tr>
        <td>${o.order_code}</td>
        <td>${isStoreSale(o) ? "Store sale" : "Wholesale"}</td>
        <td>${NETWORKS[o.network]?.name || o.network} ${o.gb} GB</td>
        <td>${o.recipient_number}</td>
        <td>${formatCedi(o.amount_paid)}</td>
        <td>${o.delivery_status}</td>
        <td>${new Date(o.created_at).toLocaleString()}</td>
      </tr>`
      )
      .join("");
  }

  async function renderCustomers() {
    const orders = (await loadVisibleOrders()).filter(isStoreSale);
    const map = new Map();
    orders.forEach((o) => {
      const key = o.recipient_number;
      const row = map.get(key) || {
        number: key,
        orders: 0,
        spent: 0,
        last: o.created_at,
        networks: new Set(),
      };
      row.orders += 1;
      row.spent += Number(o.amount_paid || 0);
      row.networks.add(NETWORKS[o.network]?.name || o.network);
      if (new Date(o.created_at) > new Date(row.last)) row.last = o.created_at;
      map.set(key, row);
    });
    const customers = [...map.values()].sort((a, b) => new Date(b.last) - new Date(a.last));
    const body = document.getElementById("customers-body");
    const empty = document.getElementById("customers-empty");
    if (!customers.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = customers
      .map(
        (c) => `
      <tr>
        <td>${c.number}</td>
        <td>${c.orders}</td>
        <td>${formatCedi(c.spent)}</td>
        <td>${new Date(c.last).toLocaleString()}</td>
        <td>${[...c.networks].join(", ")}</td>
      </tr>`
      )
      .join("");
  }

  async function renderWallet() {
    const wallet = await DataLogsAPI.getWallet();
    const txs = await DataLogsAPI.getWalletTransactions();
    document.getElementById("wallet-balance").textContent = formatCedi(wallet?.balance || 0);
    document.getElementById("wallet-tx-count").textContent = String(txs.length);
    const body = document.getElementById("wallet-body");
    const empty = document.getElementById("wallet-empty");
    if (!txs.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = txs
      .map(
        (t) => `
      <tr>
        <td>${t.type}</td>
        <td>${t.type === "credit" ? "+" : "-"}${formatCedi(t.amount)}</td>
        <td>${formatCedi(t.balance_after)}</td>
        <td>${t.description || t.reference || "—"}</td>
        <td>${new Date(t.created_at).toLocaleString()}</td>
      </tr>`
      )
      .join("");
  }

  async function renderWithdrawals() {
    const list = await DataLogsAPI.getWithdrawals();
    const body = document.getElementById("withdraw-body");
    const empty = document.getElementById("withdraw-empty");
    if (!list.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = list
      .map(
        (w) => `
      <tr>
        <td>${formatCedi(w.amount)}</td>
        <td>${w.momo_number}${w.account_name ? ` · ${w.account_name}` : ""}</td>
        <td>${w.status}</td>
        <td>${new Date(w.created_at).toLocaleString()}</td>
      </tr>`
      )
      .join("");
  }

  // Overview labels already set in HTML

  packages = await DataLogsAPI.fetchPackages();
  window.__PACKAGES = packages;
  const prices = await DataLogsAPI.getAgentStorePrices(profile.id);
  priceMap = new Map(prices.map((p) => [p.package_id, Number(p.profit)]));
  await refreshStoreUI();
  await renderOverview();
  renderPricing();
  renderWholesale();
  await renderOrders();
  await renderCustomers();
  await renderWallet();
  await renderWithdrawals();
})();
