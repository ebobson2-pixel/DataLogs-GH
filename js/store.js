(function storePage() {
  const NETWORK_ORDER = ["mtn", "airteltigo", "telecel"];
  const NET_UI = {
    mtn: { tab: "MTN", chip: "Yellow SIM · 024, 025, 053+" },
    airteltigo: { tab: "AirtelTigo", chip: "AT · 026, 027, 056+" },
    telecel: { tab: "Telecel", chip: "Telecel · 020, 050" },
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
      <button class="card package-card package-card--${item.network}" type="button" data-buy="${item.id}" data-tier="retail" data-store-id="${storeId}">
        ${item.tag ? `<span class="tag">${escapeHtml(item.tag)}</span>` : ""}
        <div class="pill">${net}</div>
        <div class="gb">${item.gb}<span> GB</span></div>
        <div class="meta">${escapeHtml(item.validity || "Non expiry")} &middot; Instant send</div>
        <div class="price">${formatCedi(item.price)}</div>
        <div class="tap-hint">Tap to buy &rarr;</div>
      </button>
    `;
  }

  function networkBlock(netId, list, storeId) {
    if (!list.length) return "";
    const net = NETWORKS[netId];
    return `
      <section class="network-packages-section network-packages-section--${netId}">
        <div class="network-packages-head">
          <span class="pill">${net.name}</span>
          <h3>${net.name} bundles</h3>
          <p class="hint">${net.blurb || NET_UI[netId]?.chip || ""}</p>
        </div>
        <div class="package-grid">
          ${list.map((item) => bundleCard(item, storeId)).join("")}
        </div>
      </section>
    `;
  }

  function paintCatalog(grid, packages, networks, filter, storeId) {
    const scoped = packages.filter((p) => filter === "all" || p.network === filter);
    if (!scoped.length) {
      grid.className = "";
      grid.innerHTML = `<p class="hint">No priced packages yet. This agent still needs to set store pricing.</p>`;
      return;
    }

    if (filter === "all") {
      grid.className = "package-groups";
      grid.innerHTML = NETWORK_ORDER.filter((id) => networks.includes(id))
        .map((netId) => networkBlock(netId, sortPackages(scoped.filter((p) => p.network === netId)), storeId))
        .filter(Boolean)
        .join("");
      return;
    }

    grid.className = "package-grid";
    grid.innerHTML = sortPackages(scoped).map((item) => bundleCard(item, storeId)).join("");
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function hexToRgb(hex) {
    const raw = String(hex || "").replace("#", "");
    const h = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function applyStoreAccent(accentId) {
    const accent = window.DataLogsTheme?.accentById?.(accentId) || { id: "sea", hex: "#2ec8e6" };
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.setAttribute("data-accent", accent.id || accentId || "sea");
    const rgb = hexToRgb(accent.hex);
    document.documentElement.style.setProperty("--accent", accent.hex);
    document.documentElement.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    document.documentElement.style.setProperty("--yellow", accent.hex);
    document.documentElement.style.setProperty("--yellow-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
    document.documentElement.style.setProperty("--yellow-glow", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)`);
  }

  function telHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 9) return null;
    return `tel:${digits.startsWith("0") ? digits : `+${digits}`}`;
  }

  function bindStoreMenu(wa, agentPhone) {
    const call = document.getElementById("store-nav-call");
    const waNav = document.getElementById("store-nav-wa");
    const track = document.getElementById("store-nav-track");
    const navTabs = document.getElementById("store-nav-tabs");
    const menuToggle = document.getElementById("store-menu-toggle");
    const toggleLabel = menuToggle?.querySelector(".store-menu-toggle-label");

    const tel = telHref(agentPhone);
    if (tel && call) {
      call.href = tel;
      call.hidden = false;
    }
    if (wa && waNav) {
      waNav.href = wa;
      waNav.hidden = false;
    }

    function setMenuOpen(open) {
      if (!navTabs || !menuToggle) return;
      navTabs.hidden = !open;
      navTabs.classList.toggle("is-open", open);
      menuToggle.classList.toggle("is-open", open);
      menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (toggleLabel) toggleLabel.textContent = open ? "Close" : "Menu";
    }

    menuToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      setMenuOpen(Boolean(navTabs?.hidden));
    });

    document.addEventListener("click", (event) => {
      if (!navTabs || navTabs.hidden) return;
      if (event.target.closest(".store-header-right")) return;
      setMenuOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    });

    track?.addEventListener("click", () => {
      window.DataLogsTrack?.open?.();
      setMenuOpen(false);
    });
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
    applyStoreAccent(store.accent_color || "sea");

    const agentName = store.profiles?.full_name || "";
    const agentPhone = store.profiles?.phone || "";

    document.title = `${store.name} | DataLogs GH`;
    setText("store-name", store.name);
    setText("store-top-name", store.name);
    setText("store-kicker", store.tagline || "Agent store");
    setText("store-tagline", store.tagline || "Every bundle, one quiet shelf. Tap a size, enter the number, and pay.");

    const wa = whatsAppHref(agentPhone);
    bindStoreMenu(wa, agentPhone);

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
        <button class="filter-btn active" type="button" data-store-filter="all">All</button>
        ${networks
          .map((id) => `<button class="filter-btn" type="button" data-store-filter="${id}">${NET_UI[id]?.tab || NETWORKS[id]?.name || id}</button>`)
          .join("")}
      `;

      filters.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-store-filter]");
        if (!btn) return;
        filters.querySelectorAll(".filter-btn").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        paintCatalog(grid, storePackages, networks, btn.dataset.storeFilter, store.id);
      });
    }

    paintCatalog(grid, storePackages, networks, "all", store.id);

    if (foot) {
      foot.hidden = false;
      setText("store-foot-name", store.name);
      if (agentName) setText("store-foot-agent", `Run by ${agentName}. Powered by DataLogs GH.`);
    }
  }

  if (document.body.classList.contains("store-body")) {
    init();
  }
})();
