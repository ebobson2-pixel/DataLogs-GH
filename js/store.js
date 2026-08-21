(function storePage() {
  const NETWORK_ORDER = ["mtn", "airteltigo", "telecel"];
  const NET_UI = {
    mtn: { tab: "MTN", title: "MTN Data Bundles", chip: "Yellow SIM · 024, 025, 053+" },
    airteltigo: { tab: "AirtelTigo", title: "AirtelTigo Data Bundles", chip: "AT · 026, 027, 056+" },
    telecel: { tab: "Telecel", title: "Telecel Data Bundles", chip: "Telecel · 020, 050" },
  };

  function sortPackages(list) {
    return [...list].sort((a, b) => {
      const orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (orderDiff !== 0) return orderDiff;
      return Number(a.gb) - Number(b.gb);
    });
  }

  function whatsAppHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 9) return null;
    let wa = digits;
    if (wa.startsWith("0") && wa.length === 10) wa = `233${wa.slice(1)}`;
    return `https://wa.me/${wa}?text=${encodeURIComponent("Hi, I want to buy a data bundle from your store.")}`;
  }

  function bundleCard(item, storeId) {
    const net = NETWORKS[item.network]?.name || item.network;
    return `
      <button class="store-bundle store-bundle--${item.network}" type="button" data-buy="${item.id}" data-tier="retail" data-store-id="${storeId}">
        ${item.tag ? `<span class="store-bundle-tag">${escapeHtml(item.tag)}</span>` : ""}
        <div class="store-bundle-net">${net}</div>
        <div class="store-bundle-gb">${item.gb}<span>GB</span></div>
        <div class="store-bundle-meta">${escapeHtml(item.validity || "Non expiry")}</div>
        <div class="store-bundle-price">${formatCedi(item.price)}</div>
        <span class="store-bundle-btn">BUY NOW</span>
      </button>
    `;
  }

  function networkBlock(netId, list, storeId) {
    if (!list.length) return "";
    const ui = NET_UI[netId] || { title: netId, chip: "" };
    return `
      <section class="store-network-block store-network-block--${netId}">
        <div class="store-network-head">
          <div>
            <h3>${ui.title}</h3>
            <p class="hint">${ui.chip}</p>
          </div>
          <span class="store-network-badge">${ui.tab}</span>
        </div>
        <div class="store-bundle-grid">
          ${list.map((item) => bundleCard(item, storeId)).join("")}
        </div>
      </section>
    `;
  }

  function paintCatalog(grid, packages, networks, filter, storeId) {
    const scoped = packages.filter((p) => filter === "all" || p.network === filter);
    if (!scoped.length) {
      grid.innerHTML = `<div class="store-empty">No priced packages yet. This agent still needs to set store pricing.</div>`;
      return;
    }

    if (filter === "all") {
      grid.innerHTML = NETWORK_ORDER.filter((id) => networks.includes(id))
        .map((netId) => networkBlock(netId, sortPackages(scoped.filter((p) => p.network === netId)), storeId))
        .filter(Boolean)
        .join("");
      return;
    }

    grid.innerHTML = `
      <div class="store-bundle-grid store-bundle-grid--solo">
        ${sortPackages(scoped).map((item) => bundleCard(item, storeId)).join("")}
      </div>
    `;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const storedSlug = (sessionStorage.getItem("datalogs_store_slug") || localStorage.getItem("datalogs_store_slug") || "").toLowerCase();
    let slug = (params.get("s") || storedSlug || "").toLowerCase();

    if (slug && params.get("s") !== slug) {
      const next = new URL(window.location.href);
      next.searchParams.set("s", slug);
      history.replaceState({}, "", next);
    }

    if (slug) {
      sessionStorage.setItem("datalogs_store_slug", slug);
      localStorage.setItem("datalogs_store_slug", slug);
    }

    function storeUrl() {
      const next = new URL(window.location.href);
      next.search = slug ? `?s=${encodeURIComponent(slug)}` : "";
      return next.pathname + next.search;
    }

    const brand = document.getElementById("store-brand-link");
    if (brand) {
      brand.setAttribute("href", storeUrl() || "#");
      brand.addEventListener("click", (event) => {
        event.preventDefault();
        window.location.replace(storeUrl());
      });
    }

    const status = document.getElementById("store-status");
    const grid = document.getElementById("store-packages");
    const filters = document.getElementById("store-filters");
    const foot = document.querySelector(".store-footer");

    function reloadStore() {
      window.location.replace(storeUrl() || window.location.pathname + window.location.search);
    }

    function scheduleReload() {
      const key = `datalogs_store_reloads_${slug || "none"}`;
      const n = Number(sessionStorage.getItem(key) || 0);
      if (n >= 3) return;
      sessionStorage.setItem(key, String(n + 1));
      setTimeout(reloadStore, 4000);
    }

    let loadFailed = false;

    function fail(title, message) {
      loadFailed = true;
      setText("store-name", title);
      setText("store-tagline", message);
      setText("store-top-name", title);
      if (status) {
        status.hidden = false;
        status.innerHTML = `<button class="store-refresh" type="button" id="store-retry">Refresh store</button>`;
        document.getElementById("store-retry")?.addEventListener("click", reloadStore);
      }
      scheduleReload();
    }

    window.addEventListener("online", () => {
      if (loadFailed) reloadStore();
    });

    if (!slug) {
      fail("Store not found", "This link is missing a store.");
      return;
    }

    let store;
    try {
      store = await DataLogsAPI.getStoreBySlug(slug);
    } catch (err) {
      fail("Store error", err.message || "Could not load store.");
      return;
    }

    if (!store || !store.published) {
      fail(
        "Store unavailable",
        store ? "This store is still in draft." : "No published store matches this link."
      );
      return;
    }

    sessionStorage.removeItem(`datalogs_store_reloads_${slug}`);
    window.__STORE_ID = store.id;

    const agentName = store.profiles?.full_name || "";
    const agentPhone = store.profiles?.phone || "";
    const initials =
      store.name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase() || "AS";

    document.title = `${store.name} | DataLogs GH`;
    setText("store-name", store.name);
    setText("store-top-name", store.name);
    setText("store-tagline", store.tagline || "Affordable. Instant. Reliable.");
    setText("store-initials", initials);
    setText("store-hero-sub", store.tagline || "Tap a bundle, enter your number, pay with MoMo or card.");

    const wa = whatsAppHref(agentPhone);
    const waChip = document.getElementById("store-wa-chip");
    const waTop = document.getElementById("store-wa-top");
    if (wa && waTop) {
      waTop.href = wa;
      waTop.hidden = false;
    }
    if (waChip) {
      if (wa) {
        waChip.style.cursor = "pointer";
        waChip.addEventListener("click", () => window.open(wa, "_blank", "noopener,noreferrer"));
      } else {
        waChip.classList.remove("store-chip--wa");
        const label = document.getElementById("store-wa-chip-label");
        const value = document.getElementById("store-wa-chip-value");
        if (label) label.textContent = "Secure payment";
        if (value) value.textContent = "MoMo & Card";
      }
    }
    if (agentPhone) {
      setText("store-phone-chip", agentPhone);
    }

    const networks = store.networks || NETWORK_ORDER;
    setText("store-net-count", String(networks.length));

    let packages = [];
    let priceRows = [];
    try {
      [packages, priceRows] = await Promise.all([
        DataLogsAPI.fetchPackages(),
        DataLogsAPI.getAgentStorePrices(store.agent_id),
      ]);
    } catch (err) {
      fail("Store error", err.message || "Could not load packages.");
      return;
    }

    const profitByPackage = new Map(priceRows.map((row) => [row.package_id, Number(row.profit)]));
    const storePackages = packages
      .filter((p) => networks.includes(p.network) && profitByPackage.has(p.id))
      .map((p) => {
        const profit = profitByPackage.get(p.id) || 0;
        return {
          ...p,
          price: Number(p.agentPrice) + profit,
          profit,
          base: Number(p.agentPrice),
        };
      });
    window.__PACKAGES = storePackages;

    setText("store-pack-count", String(storePackages.length));
    const cheapest = storePackages.reduce((min, p) => (min === null || p.price < min ? p.price : min), null);
    if (cheapest !== null) {
      setText("store-from-price", formatCedi(cheapest));
    }

    if (filters) {
      filters.hidden = false;
      filters.innerHTML = `
        <button class="store-tab active" type="button" data-store-filter="all">All networks</button>
        ${networks
          .map((id) => `<button class="store-tab store-tab--${id}" type="button" data-store-filter="${id}">${NET_UI[id]?.tab || NETWORKS[id]?.name || id}</button>`)
          .join("")}
      `;

      filters.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-store-filter]");
        if (!btn) return;
        filters.querySelectorAll(".store-tab").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        paintCatalog(grid, storePackages, networks, btn.dataset.storeFilter, store.id);
      });
    }

    paintCatalog(grid, storePackages, networks, "all", store.id);

    if (foot) {
      foot.hidden = false;
      setText("store-foot-name", store.name);
      if (agentName) setText("store-foot-agent", `Run by ${agentName}`);
    }
  }

  if (document.body.classList.contains("store-body")) {
    init();
  }
})();
