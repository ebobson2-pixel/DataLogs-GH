(function storePage() {
  const NETWORK_ORDER = ["mtn", "airteltigo", "telecel"];
  const STORE_ACCENTS = [
    { id: "sea", hex: "#2ec8e6" },
    { id: "gold", hex: "#f5c400" },
    { id: "lime", hex: "#a3e635" },
    { id: "violet", hex: "#a78bfa" },
    { id: "coral", hex: "#fb7185" },
    { id: "orange", hex: "#fb923c" },
    { id: "mint", hex: "#2dd4bf" },
    { id: "sky", hex: "#38bdf8" },
    { id: "green", hex: "#16a34a" },
    { id: "beige", hex: "#d4b896" },
  ];
  const NET_UI = {
    mtn: { tab: "MTN", emoji: "🟡", title: "MTN Data", chip: "024, 025, 053, 054, 055, 059" },
    airteltigo: { tab: "AirtelTigo", emoji: "🔵", title: "AirtelTigo Data", chip: "026, 027, 056, 057" },
    telecel: { tab: "Telecel", emoji: "🔴", title: "Telecel Data", chip: "020, 050" },
  };
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  const state = {
    slug: "",
    store: null,
    packages: [],
    bestSellerIds: new Set(),
    featuredIds: new Set(),
    filter: "all",
    query: "",
    sort: "recommended",
    storeId: null,
  };

  function sortPackages(list) {
    return [...list].sort((a, b) => {
      const orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (orderDiff !== 0) return orderDiff;
      return Number(a.gb) - Number(b.gb);
    });
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
    const yellowAccents = { gold: "#fbbf24", sea: "#fbbf24", lime: "#fbbf24", orange: "#f59e0b" };
    const accent =
      window.DataLogsTheme?.accentById?.(accentId) ||
      STORE_ACCENTS.find((a) => a.id === accentId) ||
      STORE_ACCENTS[0];
    const hex = yellowAccents[accentId] || accent.hex || "#fbbf24";
    const rgb = hexToRgb(hex);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.setAttribute("data-store-accent", accent.id || accentId || "gold");
    document.documentElement.style.setProperty("--store-accent", hex);
    document.documentElement.style.setProperty("--store-accent-deep", accentId === "orange" ? "#d97706" : "#f59e0b");
    document.documentElement.style.setProperty("--store-accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    document.documentElement.style.setProperty("--store-accent-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);
    document.documentElement.style.setProperty("--store-mtn", hex);
  }

  function applyTheme(theme) {
    document.body.classList.remove("store-theme-classic", "store-theme-premium", "store-theme-bold", "store-theme-minimal");
    document.body.classList.add(`store-theme-${theme || "classic"}`);
  }

  function storeInitials(name) {
    return String(name || "S")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  function paintLogo(store) {
    const img = document.getElementById("store-logo-img");
    const fallback = document.getElementById("store-logo-fallback");
    const foot = document.getElementById("store-foot-logo");
    const initials = storeInitials(store.name);
    if (store.logo_url && img) {
      img.src = store.logo_url;
      img.alt = `${store.name} logo`;
      img.hidden = false;
      img.onerror = () => {
        img.hidden = true;
        if (fallback) {
          fallback.hidden = false;
          fallback.textContent = initials;
        }
      };
      if (fallback) fallback.hidden = true;
    } else if (fallback) {
      fallback.hidden = false;
      fallback.textContent = initials;
      if (img) img.hidden = true;
    }
    if (foot) {
      foot.innerHTML = store.logo_url
        ? `<img class="store-logo" src="${escapeHtml(store.logo_url)}" alt="" width="32" height="32">`
        : `<span class="store-logo-fallback">${escapeHtml(initials)}</span>`;
    }
  }

  function safeImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.origin);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function paintCover(store) {
    const bg = document.getElementById("store-cover-bg");
    const banner = safeImageUrl(store.banner_url);
    if (bg && banner) {
      bg.style.backgroundImage = `linear-gradient(180deg, rgba(251,251,248,0.72), rgba(251,251,248,0.96)), url(${JSON.stringify(banner)})`;
    }
  }

  function parseTime(t) {
    const [h, m] = String(t || "00:00").split(":").map(Number);
    return h * 60 + (m || 0);
  }

  function openStatus(hours) {
    if (!hours || typeof hours !== "object") return { open: true, label: "Open now", detail: "" };
    const now = new Date();
    const key = DAY_KEYS[now.getDay()];
    const today = hours[key];
    if (!today?.open || !today?.close) return { open: true, label: "Open now", detail: "" };
    const mins = now.getHours() * 60 + now.getMinutes();
    const openM = parseTime(today.open);
    const closeM = parseTime(today.close);
    if (mins >= openM && mins < closeM) {
      return { open: true, label: "Open now", detail: `Closes ${today.close}` };
    }
    return { open: false, label: "Closed", detail: `Opens ${today.open}` };
  }

  function categoryOf(validity) {
    const v = String(validity || "").toLowerCase();
    if (v.includes("day") && !v.includes("7")) return "daily";
    if (v.includes("week") || v.includes("7 day")) return "weekly";
    if (v.includes("month") || v.includes("30")) return "monthly";
    return "standard";
  }

  function packageBadge(item) {
    if (state.featuredIds.has(item.id)) return "Featured";
    if (state.bestSellerIds.has(item.id)) return "Best seller";
    if (categoryOf(item.validity) === "monthly" && Number(item.gb) >= 10) return "Best value";
    return "";
  }

  function filteredPackages() {
    let list = state.packages.filter((p) => state.filter === "all" || p.network === state.filter);
    const q = state.query.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const net = NET_UI[p.network]?.tab || p.network;
        return `${p.gb} ${net} ${p.validity}`.toLowerCase().includes(q);
      });
    }
    if (state.sort === "price-asc") list.sort((a, b) => a.price - b.price);
    else if (state.sort === "price-desc") list.sort((a, b) => b.price - a.price);
    else if (state.sort === "gb-desc") list.sort((a, b) => Number(b.gb) - Number(a.gb));
    else if (state.sort === "popular") {
      list.sort((a, b) => {
        const ba = state.bestSellerIds.has(a.id) ? 1 : 0;
        const bb = state.bestSellerIds.has(b.id) ? 1 : 0;
        return bb - ba || Number(b.gb) - Number(a.gb);
      });
    } else {
      list = sortPackages(list);
    }
    return list;
  }

  function bundleCard(item) {
    const net = NET_UI[item.network]?.tab || NETWORKS[item.network]?.name || item.network;
    const badge = packageBadge(item);
    const delivery = state.store?.delivery_notes?.[item.network] || "1–5 min";
    return `
      <article class="store-product-card store-product-card--${item.network}">
        ${badge ? `<span class="store-product-badge">${escapeHtml(badge)}</span>` : ""}
        <div class="store-product-net">${escapeHtml(net)}</div>
        <div class="store-product-gb">${item.gb}<span>GB</span></div>
        <div class="store-product-meta">${escapeHtml(net)} Bundle</div>
        <div class="store-product-price">${formatCedi(item.price)}</div>
        <div class="store-product-eta">${escapeHtml(delivery)}</div>
        <button class="store-product-buy" type="button" data-buy="${item.id}" data-tier="retail" data-store-id="${state.storeId}">Buy now</button>
      </article>`;
  }

  function paintCatalog() {
    const grid = document.getElementById("store-packages");
    if (!grid) return;
    const list = filteredPackages();
    const networks = state.store?.networks || NETWORK_ORDER;

    if (!state.packages.length) {
      grid.innerHTML = `<div class="store-empty">This store currently has no available data bundles.</div>`;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="store-empty">${state.query ? "No bundles match your search." : "No bundles are currently available for this network."}</div>`;
      return;
    }

    if (state.filter === "all") {
      grid.innerHTML = NETWORK_ORDER.filter((id) => networks.includes(id))
        .map((netId) => {
          const netList = list.filter((p) => p.network === netId);
          if (!netList.length) return "";
          const ui = NET_UI[netId];
          return `
            <section class="store-network-block store-network-block--${netId}">
              <div class="store-network-head store-hub-network-head">
                <div>
                  <p class="store-hub-net-label">${escapeHtml(ui?.tab || netId)}</p>
                  <h3>${escapeHtml(ui?.tab || netId)} · ${netList.length} bundle${netList.length === 1 ? "" : "s"}</h3>
                </div>
              </div>
              <div class="store-product-grid">${netList.map(bundleCard).join("")}</div>
            </section>`;
        })
        .filter(Boolean)
        .join("");
    } else {
      grid.innerHTML = `<div class="store-product-grid">${list.map(bundleCard).join("")}</div>`;
    }
  }

  function paintDeals() {
    const el = document.getElementById("store-deals");
    if (!el) return;
    const deals = state.packages.filter((p) => state.featuredIds.has(p.id) || state.bestSellerIds.has(p.id)).slice(0, 4);
    if (!deals.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <h3 class="store-deals-title">Popular picks</h3>
      <div class="store-product-grid store-product-grid--deals">${deals.map(bundleCard).join("")}</div>`;
  }

  function paintFilters() {
    const filters = document.getElementById("store-filters");
    const networks = state.store?.networks || NETWORK_ORDER;
    if (!filters) return;
    filters.innerHTML = `
      <button class="store-tab active" type="button" data-store-filter="all">All</button>
      ${networks
        .map(
          (id) =>
            `<button class="store-tab store-tab--${id}" type="button" data-store-filter="${id}">${NET_UI[id]?.emoji || ""} ${NET_UI[id]?.tab || id}</button>`
        )
        .join("")}`;
  }

  function paintMeta(store) {
    const title = `${store.name} — Affordable Data Bundles | DataLogs`;
    const desc =
      store.description ||
      store.tagline ||
      `Buy affordable MTN, Telecel and AirtelTigo data from ${store.name}, powered by DataLogs.`;
    document.title = title;
    document.getElementById("meta-title")?.setAttribute("content", title);
    document.getElementById("meta-desc")?.setAttribute("content", desc);

    setText("store-name", store.name);
    setText("store-top-name", store.name);
    setText("store-tagline", store.tagline || store.description || "Pick a bundle below. Pay by Mobile Money. Delivered in 1–5 min.");
    setText("store-brand-sub", store.tagline || "Data bundles shop");
    setText("store-foot-name", store.name);

    const status = openStatus(store.opening_hours);
    const badges = document.getElementById("store-badges");
    if (badges) {
      const rating =
        Number(store.rating_count) > 0
          ? `<span class="store-badge">⭐ ${Number(store.rating_avg).toFixed(1)}</span>`
          : "";
      badges.innerHTML = `
        ${rating}
        <span class="store-badge store-badge--${status.open ? "open" : "closed"}">${status.open ? "🟢" : "🔴"} ${status.label}</span>
        ${store.verified_agent ? `<span class="store-badge store-badge--verified">Verified agent</span>` : ""}
        ${status.detail ? `<span class="store-badge store-badge--muted">${escapeHtml(status.detail)}</span>` : ""}`;
    }

    const loc = document.getElementById("store-location");
    if (loc && store.location) {
      loc.hidden = false;
      loc.textContent = `📍 ${store.location}`;
    }

    const promoBar = document.getElementById("store-promo-bar");
    const promoText = document.getElementById("store-promo-text");
    const promo = store.promo_message || store.tagline;
    if (promoBar && promoText && promo) {
      promoBar.hidden = false;
      promoText.textContent = promo;
    }

    const strip = document.getElementById("store-stats-strip");
    if (strip) {
      const fromPrice = state.packages.length ? Math.min(...state.packages.map((p) => p.price)) : 0;
      strip.innerHTML = `
        <article><strong>${state.packages.length}</strong><span>Plans</span></article>
        <article><strong>${(store.networks || []).length}</strong><span>Networks</span></article>
        <article><strong>${Number(store.order_count || 0)}</strong><span>Orders</span></article>
        <article><strong>${fromPrice ? formatCedi(fromPrice) : "—"}</strong><span>From</span></article>`;
    }
  }

  function subagentSignupUrl(store) {
    const ref = store?.slug || store?.agent_id;
    if (!ref) return "agent/auth.html";
    return `agent/auth.html?ref=${encodeURIComponent(ref)}`;
  }

  function paintSubagentCta(store) {
    const section = document.getElementById("store-subagent");
    const link = document.getElementById("store-subagent-link");
    const copy = document.getElementById("store-subagent-copy");
    const enabled = !!store?.subagents_enabled;
    if (section) section.hidden = !enabled;
    if (!enabled) {
      document.getElementById("store-mobile-subagent")?.remove();
      document.getElementById("store-nav-subagent")?.remove();
      document.getElementById("store-footer-subagent")?.remove();
      return;
    }
    const href = subagentSignupUrl(store);
    if (link) {
      link.href = href;
      link.textContent = "Become a subagent";
    }
    if (copy) {
      copy.textContent = `Join ${store.name || "this store"} as a reseller. Register free, set your selling prices, and earn on every sale.`;
    }

    const deskNav = document.querySelector(".store-hub-nav");
    if (deskNav && !document.getElementById("store-nav-subagent")) {
      const a = document.createElement("a");
      a.id = "store-nav-subagent";
      a.href = "#store-subagent";
      a.textContent = "Become a subagent";
      deskNav.appendChild(a);
    }

    const mobileNav = document.getElementById("store-mobile-nav");
    if (mobileNav && !document.getElementById("store-mobile-subagent")) {
      const a = document.createElement("a");
      a.id = "store-mobile-subagent";
      a.href = href;
      a.textContent = "Become a subagent";
      mobileNav.appendChild(a);
    }

    const footerNav = document.querySelector(".store-hub-footer-links");
    if (footerNav && !document.getElementById("store-footer-subagent")) {
      const a = document.createElement("a");
      a.id = "store-footer-subagent";
      a.href = href;
      a.textContent = "Become a subagent";
      footerNav.appendChild(a);
    }
  }

  function paintHeroActions(contactWa, contactTel, store) {
    const el = document.getElementById("store-hero-actions");
    if (!el) return;
    const subCta = store?.subagents_enabled
      ? `<a class="store-btn store-btn--ghost" href="${subagentSignupUrl(store)}">Become a subagent</a>`
      : "";
    el.innerHTML = `
      <a class="store-btn store-btn--yellow" href="#store-data">Buy data now</a>
      ${contactWa ? `<a class="store-btn store-btn--wa" href="${contactWa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
      ${contactTel ? `<a class="store-btn store-btn--ghost" href="${contactTel}">Call store</a>` : ""}
      ${subCta}
      <button class="store-btn store-btn--ghost" type="button" id="store-hero-share">Share store</button>`;
    el.querySelector("#store-hero-share")?.addEventListener("click", shareStore);
  }

  function paintTrust(store, contactWa) {
    const grid = document.getElementById("store-trust-grid");
    if (!grid) return;
    const items = [
      { icon: "⚡", title: "Fast checkout", text: "Pay with MoMo or card in seconds." },
      { icon: "🔐", title: "Secure payments", text: "Processed securely via DataLogs & Paystack." },
      { icon: "📱", title: "Major networks", text: `${(store.networks || []).map((n) => NET_UI[n]?.tab || n).join(", ")}` },
    ];
    if (contactWa) items.push({ icon: "💬", title: "WhatsApp support", text: "Message the store team directly." });
    if (store.verified_agent) items.push({ icon: "✓", title: "Verified agent", text: "Activated DataLogs agent account." });
    grid.innerHTML = items
      .map(
        (i) => `<article class="store-trust-card"><span aria-hidden="true">${i.icon}</span><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.text)}</p></article>`
      )
      .join("");
  }

  function paintDelivery(store) {
    const card = document.getElementById("store-delivery-card");
    if (!card) return;
    const notes = store.delivery_notes || {};
    const nets = store.networks || NETWORK_ORDER;
    card.innerHTML = `
      <h3>Delivery estimates</h3>
      <p class="hint">Typical processing times — not guaranteed.</p>
      <ul class="store-delivery-list">
        ${nets
          .map((n) => `<li><strong>${NET_UI[n]?.tab || n}</strong><span>${escapeHtml(notes[n] || "Processing after payment")}</span></li>`)
          .join("")}
      </ul>`;
  }

  function paintReviews(store, reviews) {
    const el = document.getElementById("store-reviews");
    if (!el) return;
    if (!reviews?.length && !Number(store.rating_count)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <h3>What customers say</h3>
      ${Number(store.rating_count) ? `<p class="store-rating-summary"><strong>${Number(store.rating_avg).toFixed(1)}/5</strong> · ${store.rating_count} review${store.rating_count === 1 ? "" : "s"} · ${Number(store.order_count || 0)} verified purchases</p>` : ""}
      <div class="store-review-list">
        ${(reviews || [])
          .map(
            (r) => `<blockquote class="store-review"><span class="store-review-stars">${"⭐".repeat(r.rating)}</span>${r.comment ? `<p>${escapeHtml(r.comment)}</p>` : ""}</blockquote>`
          )
          .join("")}
      </div>`;
  }

  function paintContact(store, contactWa, contactTel) {
    const grid = document.getElementById("store-contact-grid");
    if (!grid) return;
    grid.innerHTML = `
      ${contactWa ? `<a class="store-contact-card" href="${contactWa}" target="_blank" rel="noopener"><strong>WhatsApp</strong><span>Chat with this store</span></a>` : ""}
      ${contactTel ? `<a class="store-contact-card" href="${contactTel}"><strong>Phone</strong><span>Call the store</span></a>` : ""}
      ${store.contact_email ? `<a class="store-contact-card" href="mailto:${escapeHtml(store.contact_email)}"><strong>Email</strong><span>${escapeHtml(store.contact_email)}</span></a>` : ""}
      ${store.location ? `<div class="store-contact-card store-contact-card--static"><strong>Location</strong><span>${escapeHtml(store.location)}</span></div>` : ""}`;
  }

  function paintTrackSection() {
    const box = document.getElementById("store-track-box");
    if (!box) return;
    box.innerHTML = `
      <form class="store-track-form" id="store-inline-track">
        <label>Transaction ID<input name="code" required placeholder="DL-ABC12345" autocomplete="off"></label>
        <button class="store-btn store-btn--primary" type="submit">Track order</button>
      </form>
      <div id="store-track-results" class="store-track-results"></div>`;
    box.querySelector("#store-inline-track")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get("code");
      const out = document.getElementById("store-track-results");
      if (!out) return;
      out.innerHTML = `<p class="hint">Looking up order…</p>`;
      try {
        const rows = await DataLogsAPI.trackOrderByCode(String(code).trim());
        if (!rows?.length) {
          out.innerHTML = `<p class="store-empty">No order found for that ID.</p>`;
          return;
        }
        const o = rows[0];
        const st = publicDeliveryLabel(o.delivery_status);
        out.innerHTML = `
          <article class="store-track-result">
            <strong>${escapeHtml(o.order_code)}</strong>
            <p>${escapeHtml(st)} · ${formatCedi(o.amount_paid)}</p>
            <p class="hint">${escapeHtml(o.network?.toUpperCase() || "")} ${o.gb}GB → ${escapeHtml(o.recipient_number || "")}</p>
            <a class="store-btn store-btn--ghost" href="customer/refunds.html?order=${encodeURIComponent(o.order_code)}">Get help</a>
          </article>`;
      } catch (err) {
        out.innerHTML = `<p class="store-empty">${escapeHtml(err.message || "Could not track order.")}</p>`;
      }
    });
  }

  function storePublicUrl(slug, productId) {
    const url = new URL(window.location.href);
    url.search = `?s=${encodeURIComponent(slug)}`;
    if (productId) url.searchParams.set("buy", productId);
    return url.href;
  }

  async function shareStore() {
    const url = storePublicUrl(state.slug);
    const title = `${state.store?.name || "Data store"} on DataLogs`;
    const text = state.store?.tagline || "Buy affordable data bundles";
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch {
        /* user cancelled */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      window.alert("Store link copied!");
    } catch {
      window.prompt("Copy this store link:", url);
    }
  }

  async function shareProduct(item) {
    const url = storePublicUrl(state.slug, item.id);
    const text = `${NET_UI[item.network]?.tab || item.network} ${item.gb}GB — ${formatCedi(item.price)}\nBuy from ${state.store.name}:\n${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${item.gb}GB data`, text, url });
        return;
      } catch {
        /* cancelled */
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      window.alert("Product link copied!");
    } catch {
      window.prompt("Copy:", text);
    }
  }

  function showApp() {
    document.body.removeAttribute("data-store-loading");
    document.getElementById("store-skeleton")?.setAttribute("hidden", "");
    document.getElementById("store-app")?.removeAttribute("hidden");
    document.getElementById("store-error")?.setAttribute("hidden", "");
  }

  function showError(title, message) {
    document.body.removeAttribute("data-store-loading");
    document.getElementById("store-skeleton")?.setAttribute("hidden", "");
    document.getElementById("store-app")?.setAttribute("hidden", "");
    const err = document.getElementById("store-error");
    if (err) {
      err.removeAttribute("hidden");
      setText("store-error-title", title);
      setText("store-error-msg", message);
    }
  }

  function bindEvents(contactWa, contactTel) {
    document.getElementById("store-share-btn")?.addEventListener("click", shareStore);
    document.getElementById("store-filters")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-store-filter]");
      if (!btn) return;
      state.filter = btn.dataset.storeFilter;
      document.querySelectorAll("#store-filters .store-tab").forEach((el) => el.classList.toggle("active", el === btn));
      paintCatalog();
    });
    document.getElementById("store-search")?.addEventListener("input", (e) => {
      state.query = e.target.value;
      paintCatalog();
    });
    document.getElementById("store-sort")?.addEventListener("change", (e) => {
      state.sort = e.target.value;
      paintCatalog();
    });

    [document.getElementById("store-packages"), document.getElementById("store-deals")].forEach((root) => {
      root?.addEventListener("click", (e) => {
        const share = e.target.closest("[data-share-product]");
        if (share) {
          const item = state.packages.find((p) => p.id === share.dataset.shareProduct);
          if (item) shareProduct(item);
        }
      });
    });

    const menuToggle = document.getElementById("store-menu-toggle");
    const mobileNav = document.getElementById("store-mobile-nav");
    menuToggle?.addEventListener("click", () => {
      const open = mobileNav?.hasAttribute("hidden");
      if (open) mobileNav?.removeAttribute("hidden");
      else mobileNav?.setAttribute("hidden", "");
      menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    mobileNav?.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => mobileNav?.setAttribute("hidden", ""));
    });

    if (contactWa) {
      document.getElementById("store-wa-fab")?.removeAttribute("hidden");
      const fab = document.getElementById("store-wa-fab");
      if (fab) fab.href = contactWa;
      const mwa = document.getElementById("store-mobile-wa");
      if (mwa) mwa.href = contactWa;
    }
    if (contactTel) {
      const mcall = document.getElementById("store-mobile-call");
      if (mcall) mcall.href = contactTel;
    }

    document.getElementById("store-retry-btn")?.addEventListener("click", () => window.location.reload());
    document.getElementById("store-open-tracker")?.addEventListener("click", () => {
      window.DataLogsTrack?.open?.();
    });

    document.querySelectorAll(".store-hub-nav a, .store-hub-mobile-nav a, .store-hub-footer-links a").forEach((link) => {
      link.addEventListener("click", (e) => {
        const href = link.getAttribute("href");
        if (href?.startsWith("#") && href.length > 1) {
          e.preventDefault();
          document.querySelector(href)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  }

  function normalizePackages(raw) {
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    return list.map((p) => ({
      ...p,
      price: Number(p.price),
      gb: Number(p.gb),
    }));
  }

  async function loadStoreLegacy(slug) {
    const store = await DataLogsAPI.getStoreBySlug(slug);
    if (!store?.published) return { store: null };
    const [packages, priceRows] = await Promise.all([
      DataLogsAPI.fetchPackages(),
      DataLogsAPI.getAgentStorePrices(store.agent_id),
    ]);
    const profitByPackage = new Map(priceRows.map((row) => [row.package_id, Number(row.profit)]));
    const networks = store.networks || NETWORK_ORDER;
    const priced = packages
      .filter((p) => p.active !== false && networks.includes(p.network))
      .map((p) => {
        const resolved = resolveStorePackagePrice(p, profitByPackage);
        return {
          id: p.id,
          network: p.network,
          gb: p.gb,
          validity: p.validity,
          sort_order: p.sort_order,
          price: resolved.price,
          profit: resolved.profit,
          custom_priced: resolved.custom,
        };
      });
    return { store, packages: priced, best_sellers: [], reviews: [] };
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const storedSlug = (sessionStorage.getItem("datalogs_store_slug") || localStorage.getItem("datalogs_store_slug") || "").toLowerCase();
    state.slug = (params.get("s") || storedSlug || "").toLowerCase();

    if (state.slug && params.get("s") !== state.slug) {
      const next = new URL(window.location.href);
      next.searchParams.set("s", state.slug);
      history.replaceState({}, "", next);
    }
    if (state.slug) {
      sessionStorage.setItem("datalogs_store_slug", state.slug);
      localStorage.setItem("datalogs_store_slug", state.slug);
    }

    const brand = document.getElementById("store-brand-link");
    if (brand) {
      brand.href = state.slug ? `?s=${encodeURIComponent(state.slug)}` : "#";
      brand.addEventListener("click", (e) => {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    if (!state.slug) {
      showError("Store not found", "This link is missing a store code. Ask the agent for their store link.");
      return;
    }

    let catalog;
    try {
      catalog = await DataLogsAPI.getStoreCatalog(state.slug);
    } catch (err) {
      console.warn("get_store_catalog failed, falling back", err);
      catalog = await loadStoreLegacy(state.slug);
    }

    if (!catalog?.store) {
      showError("Store unavailable", "This store is not published or does not exist.");
      return;
    }

    const store = catalog.store;
    state.store = store;
    state.storeId = store.id;
    state.packages = normalizePackages(catalog.packages);
    window.__STORE_ID = store.id;
    window.__PACKAGES = state.packages;

    state.bestSellerIds = new Set((catalog.best_sellers || []).map((b) => b.package_id));
    state.featuredIds = new Set(
      (Array.isArray(store.featured_package_ids) ? store.featured_package_ids : []).filter(Boolean)
    );

    DataLogsAPI.recordStoreView(state.slug).catch(() => {});

    applyStoreAccent(store.accent_color || "gold");
    applyTheme(store.theme || "classic");

    const contactTel = store.contact_tel;
    const contactWa = store.contact_wa;

    paintLogo(store);
    paintCover(store);
    paintMeta(store);
    paintHeroActions(contactWa, contactTel, store);
    paintSubagentCta(store);
    paintFilters();
    paintDeals();
    paintCatalog();
    paintTrust(store, contactWa);
    paintDelivery(store);
    paintReviews(store, catalog.reviews);
    paintContact(store, contactWa, contactTel);
    bindEvents(contactWa, contactTel);
    showApp();

    const buyId = params.get("buy") || params.get("product");
    if (buyId) {
      document.querySelector(`[data-buy="${buyId}"]`)?.click();
    }
  }

  if (document.body.classList.contains("store-body")) {
    init();
  }
})();
