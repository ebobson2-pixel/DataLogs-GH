(async function dashboard() {
  const profile = await DataLogsAPI.requireProfile(["agent", "admin"], "auth.html");
  if (!profile) return;
  if (profile.role === "admin") {
    window.location.href = "../admin/dashboard.html";
    return;
  }
  try {
    const access = await DataLogsAPI.syncAgentActivation();
    if (access.required && !access.activated) {
      window.location.href = "activate.html";
      return;
    }
  } catch {
    /* continue; dashboard still loads if sync fails after auth */
  }

  const shell = document.getElementById("dash-shell");
  const titles = {
    overview: ["Overview", "Live sales, profit, and traffic"],
    store: ["Mini store", "Your unique storefront"],
    flyer: ["Flyers", "Download a price poster for your store"],
    pricing: ["Store pricing", "Markup all bundles for one network"],
    wholesale: ["Buy wholesale", "Subsidized agent rates"],
    orders: ["Orders", "Store sales & wholesale"],
    customers: ["Customers", "People who bought from your store"],
    wallet: ["My Wallet", "Commissions and balance"],
    withdrawal: ["Withdrawal", "Cash out to MoMo"],
    developer: ["API keys", "Connect your own website"],
    account: ["Account", "Profile details"],
  };

  let wholesaleFilter = "all";
  let pricingFilter = "mtn";
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

  function paintSupport(settings) {
    const meta = supportContactMeta(settings);
    const overview = document.getElementById("overview-support");
    const account = document.getElementById("account-support");
    const chip = document.getElementById("topbar-support");
    [overview, account, chip].forEach((el) => {
      if (el) el.hidden = !meta;
    });
    if (!meta) return;
    const actions = (id) => {
      const parts = [];
      if (meta.tel) parts.push(`<a class="btn btn-ghost" href="${meta.tel}">Call</a>`);
      if (meta.wa) parts.push(`<a class="btn btn-primary" href="${meta.wa}" target="_blank" rel="noopener">WhatsApp</a>`);
      if (meta.href && !meta.tel) parts.push(`<a class="btn btn-primary" href="${meta.href}">${escapeHtml(meta.contact)}</a>`);
      if (!parts.length) parts.push(`<p>${escapeHtml(meta.contact)}</p>`);
      document.getElementById(id).innerHTML = parts.join("");
    };
    document.getElementById("overview-support-title").textContent = meta.label;
    document.getElementById("overview-support-text").textContent = meta.contact;
    document.getElementById("account-support-title").textContent = meta.label;
    document.getElementById("account-support-text").textContent = meta.contact;
    actions("overview-support-actions");
    actions("account-support-actions");
    chip.textContent = meta.label;
    chip.href = meta.wa || meta.href || "#";
    if (!meta.wa && !meta.href) {
      chip.removeAttribute("target");
      chip.href = "#";
      chip.addEventListener("click", (event) => event.preventDefault());
    }
  }

  DataLogsAPI.getSiteSettings().then(paintSupport).catch(() => {});

  function setCollapseIcon(collapsed) {
    var btn = document.getElementById("collapse-btn");
    if (!btn) return;
    btn.setAttribute("data-icon", collapsed ? "expand" : "collapse");
    window.DashIcons?.paint(btn);
  }

  document.getElementById("collapse-btn").addEventListener("click", () => {
    shell.classList.toggle("collapsed");
    const collapsed = shell.classList.contains("collapsed");
    setCollapseIcon(collapsed);
    localStorage.setItem("datalogs_sidebar", collapsed ? "1" : "0");
  });

  if (localStorage.getItem("datalogs_sidebar") === "1" && window.innerWidth > 980) {
    shell.classList.add("collapsed");
    setCollapseIcon(true);
  }

  document.getElementById("mobile-menu-btn").addEventListener("click", () => {
    shell.classList.toggle("mobile-open");
  });
  document.getElementById("dash-scrim")?.addEventListener("click", () => {
    shell.classList.remove("mobile-open");
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
    if (id === "developer") renderApiKeys();
    if (id === "overview") renderOverview();
    if (id === "flyer") renderFlyerPreview();
  }

  const runRafs = new Map();
  let overviewTimer = null;
  let overviewChartData = null;
  let salesChartDraw = 0;
  let networkChartDraw = 0;

  function runNumber(el, to, decimals = 0) {
    if (!el) return;
    const from = Number(el.dataset.runValue || 0);
    const target = Number(to) || 0;
    el.dataset.runValue = String(target);
    if (runRafs.has(el)) cancelAnimationFrame(runRafs.get(el));
    if (from === target) {
      el.textContent = target.toFixed(decimals);
      return;
    }
    const start = performance.now();
    const dur = 900;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (target - from) * eased;
      el.textContent = val.toFixed(decimals);
      if (t < 1) {
        const id = requestAnimationFrame(tick);
        runRafs.set(el, id);
      } else {
        el.textContent = target.toFixed(decimals);
        runRafs.delete(el);
      }
    };
    runRafs.set(el, requestAnimationFrame(tick));
  }

  function localDayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function lastSevenDays() {
    const days = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({
        date: d,
        key: localDayKey(d),
        label: d.toLocaleDateString(undefined, { weekday: "short" }),
      });
    }
    return days;
  }

  function drawSpark(svg, values, color = "#2ec8e6") {
    if (!svg) return;
    const nums = values.length ? values : [0, 0];
    const max = Math.max(...nums, 1);
    const w = 120;
    const h = 36;
    const step = nums.length > 1 ? w / (nums.length - 1) : w;
    const pts = nums.map((v, i) => {
      const x = i * step;
      const y = h - 4 - (v / max) * (h - 8);
      return `${x},${y}`;
    });
    const area = `0,${h} ${pts.join(" ")} ${w},${h}`;
    svg.innerHTML = `<polygon points="${area}" fill="${color}" fill-opacity="0.16"></polygon><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
  }

  function sizeCanvas(canvas) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width || canvas.width));
    const height = Math.max(200, Math.floor(rect.height || 240));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
  }

  function drawSalesChart(canvas, days, storeSeries, wholesaleSeries) {
    cancelAnimationFrame(salesChartDraw);
    const { ctx, width, height } = sizeCanvas(canvas);
    const pad = { t: 18, r: 12, b: 28, l: 36 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const max = Math.max(1, ...storeSeries, ...wholesaleSeries);
    const start = performance.now();

    const pointX = (i) => pad.l + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
    const pointY = (v, p) => pad.t + innerH - (v / max) * innerH * p;

    const paint = (p) => {
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const y = pad.t + (innerH / 4) * g;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(width - pad.r, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#8b8b8b";
      ctx.font = "11px Outfit, sans-serif";
      ctx.textAlign = "center";
      days.forEach((d, i) => ctx.fillText(d.label, pointX(i), height - 8));
      ctx.textAlign = "right";
      ctx.fillText(String(max), pad.l - 8, pad.t + 4);

      ctx.beginPath();
      storeSeries.forEach((v, i) => {
        const x = pointX(i);
        const y = pointY(v, p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#2ec8e6";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.lineTo(pointX(storeSeries.length - 1), pad.t + innerH);
      ctx.lineTo(pointX(0), pad.t + innerH);
      ctx.closePath();
      ctx.fillStyle = "rgba(46, 200, 230, 0.16)";
      ctx.fill();

      ctx.beginPath();
      wholesaleSeries.forEach((v, i) => {
        const x = pointX(i);
        const y = pointY(v, p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      storeSeries.forEach((v, i) => {
        ctx.beginPath();
        ctx.arc(pointX(i), pointY(v, p), 3.2, 0, Math.PI * 2);
        ctx.fillStyle = "#2ec8e6";
        ctx.fill();
      });
    };

    const tick = (now) => {
      const t = Math.min(1, (now - start) / 850);
      const eased = 1 - Math.pow(1 - t, 3);
      paint(eased);
      if (t < 1) salesChartDraw = requestAnimationFrame(tick);
    };
    salesChartDraw = requestAnimationFrame(tick);
  }

  function drawNetworkChart(canvas, slices) {
    cancelAnimationFrame(networkChartDraw);
    const { ctx, width, height } = sizeCanvas(canvas);
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - 16;
    const total = slices.reduce((s, x) => s + x.value, 0) || 1;
    const start = performance.now();

    const paint = (p) => {
      ctx.clearRect(0, 0, width, height);
      let angle = -Math.PI / 2;
      if (!slices.some((s) => s.value > 0)) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 22;
        ctx.stroke();
        return;
      }
      slices.filter((s) => s.value > 0).forEach((slice) => {
        const sweep = (slice.value / total) * Math.PI * 2 * p;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, angle, angle + sweep);
        ctx.strokeStyle = slice.color;
        ctx.lineWidth = 22;
        ctx.lineCap = "butt";
        ctx.stroke();
        angle += sweep;
      });
    };

    const tick = (now) => {
      const t = Math.min(1, (now - start) / 900);
      const eased = 1 - Math.pow(1 - t, 3);
      paint(eased);
      if (t < 1) networkChartDraw = requestAnimationFrame(tick);
    };
    networkChartDraw = requestAnimationFrame(tick);
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
        accent_color: document.getElementById("store-accent-input")?.value || "green",
        networks,
        published: form.get("published") === "on",
      });
      storeForm.slug.value = store.slug;
      showStoreMessage("success", "Store saved. Your share link is ready.");
      await refreshStoreUI();
      try {
        await renderOverview();
      } catch (err) {
        console.error(err);
      }
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

  document.getElementById("pricing-filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pfilter]");
    if (!btn) return;
    pricingFilter = btn.dataset.pfilter;
    document.querySelectorAll("#pricing-filters .filter-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    const percent = document.getElementById("markup-percent");
    if (percent) percent.value = "";
    const warn = document.getElementById("markup-warn");
    if (warn) warn.hidden = true;
    const error = document.getElementById("pricing-error");
    const success = document.getElementById("pricing-success");
    if (error) error.hidden = true;
    if (success) success.hidden = true;
    updateMarkupCopy();
    renderPricing();
  });

  function roundCedi(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function selectedNetworkName() {
    return NETWORKS[pricingFilter]?.name || pricingFilter;
  }

  function updateMarkupCopy() {
    const el = document.getElementById("markup-info-copy");
    if (!el) return;
    const name = selectedNetworkName();
    el.innerHTML = "Markup changes all your selling prices for the selected network based on the percentage you want. Markup is applied to the <strong>Base Price</strong> (your cost). For example, if Base Price = GH\u20B5 4.10, +10% gives GH\u20B5 4.51. After applying, you must click Save Prices to keep the changes. The markup affects only the currently selected network (" + name + ").";
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

  function currentSellPrice(pkg) {
    if (priceMap.has(pkg.id)) return roundCedi(pkg.agentPrice + Number(priceMap.get(pkg.id) || 0));
    return roundCedi(pkg.agentPrice);
  }

  function updateRowProfit(packageId) {
    const pkg = packages.find((p) => p.id === packageId);
    const input = document.querySelector(`[data-sell-input="${packageId}"]`);
    const profitEl = document.querySelector(`[data-profit-preview="${packageId}"]`);
    if (!pkg || !input || !profitEl) return;
    const sell = Number(input.value);
    if (!Number.isFinite(sell)) {
      profitEl.textContent = "\u2014";
      return;
    }
    const profit = roundCedi(sell - pkg.agentPrice);
    profitEl.textContent = formatCedi(profit);
    profitEl.classList.toggle("is-low", profit < 0);
  }

  document.getElementById("markup-apply")?.addEventListener("click", () => {
    const error = document.getElementById("pricing-error");
    const success = document.getElementById("pricing-success");
    const warn = document.getElementById("markup-warn");
    error.hidden = true;
    success.hidden = true;
    warn.hidden = true;
    const percent = markupPercentValue();
    if (percent == null) {
      error.hidden = false;
      error.textContent = "Enter a markup % such as +10 or -3.";
      return;
    }
    const list = packagesFor(pricingFilter, packages);
    if (!list.length) {
      error.hidden = false;
      error.textContent = `No bundles found for ${selectedNetworkName()}.`;
      return;
    }
    const rate = percent / 100;
    let belowCost = false;
    list.forEach((pkg) => {
      const input = document.querySelector(`[data-sell-input="${pkg.id}"]`);
      if (!input) return;
      let newSell = roundCedi(pkg.agentPrice + pkg.agentPrice * rate);
      if (newSell < pkg.agentPrice) {
        newSell = roundCedi(pkg.agentPrice);
        belowCost = true;
      }
      if (newSell < 0) newSell = 0;
      input.value = newSell.toFixed(2);
      updateRowProfit(pkg.id);
    });
    const signed = `${percent > 0 ? "+" : ""}${percent}`;
    document.getElementById("markup-percent").value = signed;
    warn.hidden = false;
    warn.textContent = belowCost
      ? `Prices cannot go below cost. ${selectedNetworkName()} rows were set to base price. Click Save Prices to confirm.`
      : `This will update all prices for ${selectedNetworkName()}. Click Save Prices to confirm.`;
  });

  document.getElementById("markup-save")?.addEventListener("click", async () => {
    const error = document.getElementById("pricing-error");
    const success = document.getElementById("pricing-success");
    error.hidden = true;
    success.hidden = true;
    const inputs = [...document.querySelectorAll("#pricing-body [data-sell-input]")];
    if (!inputs.length) {
      error.hidden = false;
      error.textContent = "No bundles to save for this network.";
      return;
    }
    const items = [];
    for (const input of inputs) {
      const pkg = packages.find((p) => p.id === input.dataset.sellInput);
      const sell = Number(input.value);
      if (!pkg || !Number.isFinite(sell)) {
        error.hidden = false;
        error.textContent = "Enter a valid selling price for every bundle.";
        return;
      }
      const profit = roundCedi(sell - pkg.agentPrice);
      if (profit < 0) {
        error.hidden = false;
        error.textContent = "Selling price cannot be below base cost.";
        return;
      }
      items.push({ packageId: pkg.id, profit });
    }
    const btn = document.getElementById("markup-save");
    if (btn) btn.disabled = true;
    try {
      const rows = await DataLogsAPI.setAgentPackageProfits(items);
      rows.forEach((row) => priceMap.set(row.package_id, Number(row.profit)));
      success.hidden = false;
      success.textContent = `Saved ${rows.length} ${selectedNetworkName()} store price${rows.length === 1 ? "" : "s"}.`;
      const warn = document.getElementById("markup-warn");
      if (warn) warn.hidden = true;
      renderPricing();
      await renderOverview();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save prices.";
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("pricing-body").addEventListener("input", (event) => {
    const input = event.target.closest("[data-sell-input]");
    if (!input) return;
    updateRowProfit(input.dataset.sellInput);
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
        network: form.get("network"),
      });
      success.hidden = false;
      success.textContent = "Request sent to admin. Your wallet stays the same until they approve.";
      event.target.reset();
      await renderWithdrawals();
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

  function paintStoreAccentSwatches(selectedId) {
    const wrap = document.getElementById("store-accent-swatches");
    const input = document.getElementById("store-accent-input");
    if (!wrap || !window.DataLogsTheme) return;
    const selected = selectedId || input?.value || "sea";
    wrap.innerHTML = window.DataLogsTheme.ACCENTS.map(
      (a) =>
        `<button type="button" class="store-accent-swatch${a.id === selected ? " active" : ""}" data-store-accent="${a.id}" style="background:${a.hex}" aria-label="${a.label}" aria-pressed="${a.id === selected}"></button>`
    ).join("");
    if (input) input.value = selected;
    wrap.querySelectorAll("[data-store-accent]").forEach((btn) => {
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".store-accent-swatch").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-pressed", "true");
        if (input) input.value = btn.dataset.storeAccent;
      });
    });
  }

  async function refreshStoreUI() {
    storeCache = await DataLogsAPI.getStoreByAgent(profile.id);
    const openBtn = document.getElementById("open-store-btn");
    if (!storeCache) {
      document.getElementById("share-url").value = "";
      openBtn.href = "#";
      paintStoreAccentSwatches("green");
      return;
    }
    storeForm.name.value = storeCache.name;
    storeForm.slug.value = storeCache.slug;
    storeForm.tagline.value = storeCache.tagline || "";
    storeForm.published.checked = storeCache.published;
    storeForm.querySelectorAll("[name=networks]").forEach((box) => {
      box.checked = (storeCache.networks || []).includes(box.value);
    });
    paintStoreAccentSwatches(storeCache.accent_color || "green");
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
    const wholesale = orders.filter(isWholesale);
    const wallet = await DataLogsAPI.getWallet();
    const txs = await DataLogsAPI.getWalletTransactions();
    const profitEarned = txs
      .filter((t) => t.type === "credit")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const todayKey = localDayKey(new Date());
    const todayOrders = orders.filter((o) => localDayKey(o.created_at) === todayKey);
    const customers = new Set(storeSales.map((o) => o.recipient_number)).size;
    const days = lastSevenDays();
    const storeSeries = days.map((d) => storeSales.filter((o) => localDayKey(o.created_at) === d.key).length);
    const wholesaleSeries = days.map((d) => wholesale.filter((o) => localDayKey(o.created_at) === d.key).length);
    const orderSeries = days.map((d, i) => storeSeries[i] + wholesaleSeries[i]);
    const profitSeries = days.map((d) =>
      txs
        .filter((t) => t.type === "credit" && localDayKey(t.created_at) === d.key)
        .reduce((sum, t) => sum + Number(t.amount || 0), 0)
    );

    const storeEl = document.getElementById("stat-store");
    const storeMeta = document.getElementById("stat-store-meta");
    storeEl.textContent = store ? (store.published ? "Live" : "Draft") : "Not set";
    storeMeta.textContent = store
      ? store.published
        ? "Your storefront is public"
        : "Saved, not published"
      : "Set up your mini store";

    runNumber(document.getElementById("stat-orders"), orders.length, 0);
    runNumber(document.getElementById("stat-today"), todayOrders.length, 0);
    runNumber(document.getElementById("stat-profit"), profitEarned, 2);
    runNumber(document.getElementById("stat-saved"), wallet?.balance || 0, 2);
    runNumber(document.getElementById("stat-customers"), customers, 0);
    runNumber(document.getElementById("donut-total"), orders.length, 0);
    drawSpark(document.getElementById("spark-orders"), orderSeries);
    drawSpark(document.getElementById("spark-profit"), profitSeries, "#7dff9a");

    const networkSlices = [
      { key: "mtn", label: "MTN", color: "#ffcc00", value: orders.filter((o) => o.network === "mtn").length },
      { key: "airteltigo", label: "AirtelTigo", color: "#3b82f6", value: orders.filter((o) => o.network === "airteltigo").length },
      { key: "telecel", label: "Telecel", color: "#ef4444", value: orders.filter((o) => o.network === "telecel").length },
    ];

    document.getElementById("sales-legend").innerHTML = `
      <span class="legend-item"><i class="legend-swatch" style="background:#2ec8e6"></i>Store ${storeSales.length}</span>
      <span class="legend-item"><i class="legend-swatch" style="background:#a78bfa"></i>Wholesale ${wholesale.length}</span>
    `;
    document.getElementById("network-legend").innerHTML = networkSlices
      .map((s) => `<span class="legend-item"><i class="legend-swatch" style="background:${s.color}"></i>${s.label} ${s.value}</span>`)
      .join("");

    const salesCanvas = document.getElementById("chart-sales");
    const networkCanvas = document.getElementById("chart-network");
    overviewChartData = { days, storeSeries, wholesaleSeries, networkSlices };
    if (salesCanvas) drawSalesChart(salesCanvas, days, storeSeries, wholesaleSeries);
    if (networkCanvas) drawNetworkChart(networkCanvas, networkSlices);

    const stamp = new Date();
    document.getElementById("overview-updated").textContent = `Updated ${stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

    const box = document.getElementById("overview-orders");
    if (!orders.length) {
      box.className = "empty-state";
      box.textContent = "No orders yet.";
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

  function startLiveOverview() {
    clearInterval(overviewTimer);
    overviewTimer = setInterval(() => {
      const panel = document.querySelector('[data-panel-view="overview"]');
      if (panel && panel.classList.contains("active") && document.visibilityState === "visible") {
        renderOverview();
      }
    }, 12000);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const panel = document.querySelector('[data-panel-view="overview"]');
      if (!panel || !panel.classList.contains("active") || !overviewChartData) return;
      const salesCanvas = document.getElementById("chart-sales");
      const networkCanvas = document.getElementById("chart-network");
      if (salesCanvas) drawSalesChart(salesCanvas, overviewChartData.days, overviewChartData.storeSeries, overviewChartData.wholesaleSeries);
      if (networkCanvas) drawNetworkChart(networkCanvas, overviewChartData.networkSlices);
    }, 180);
  });

  function renderPricing() {
    const list = packagesFor(pricingFilter, packages).slice().sort((a, b) => a.gb - b.gb);
    const body = document.getElementById("pricing-body");
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="4">No ${selectedNetworkName()} bundles yet.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((item) => {
        const sell = currentSellPrice(item);
        const profit = roundCedi(sell - item.agentPrice);
        return `
          <tr>
            <td>${item.gb}GB</td>
            <td>${formatCedi(item.agentPrice)}</td>
            <td>
              <input class="markup-sell-input" data-sell-input="${item.id}" type="number" min="0" step="0.01" value="${sell.toFixed(2)}">
            </td>
            <td class="markup-profit${profit < 0 ? " is-low" : ""}" data-profit-preview="${item.id}">${formatCedi(profit)}</td>
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
            ${item.customPriced ? `<span class="badge-custom">Your price</span>` : ""}
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
        <td>${publicDeliveryLabel(o.delivery_status)}</td>
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

  const topup = {
    amount: "",
    email: profile.email || profile.authEmail || "",
    method: "momo",
    provider: "mtn",
    momoPhone: "",
    card: { number: "", month: "", year: "", cvv: "" },
    reference: null,
    challenge: null,
  };
  let topupSwapTimer = 0;
  const topupBackdrop = document.getElementById("topup-modal");
  const topupPopup = document.getElementById("topup-popup");

  function openTopupBackdrop() {
    topupBackdrop.classList.add("open");
    topupBackdrop.classList.remove("closing");
    document.body.classList.add("pay-open");
  }

  function closeTopupPopup() {
    if (!topupBackdrop.classList.contains("open")) return;
    topupBackdrop.classList.add("closing");
    setTimeout(() => {
      topupBackdrop.classList.remove("open", "closing");
      document.body.classList.remove("pay-open");
      topupPopup.innerHTML = "";
    }, 240);
  }

  function swapTopup(paint) {
    clearTimeout(topupSwapTimer);
    const already = topupPopup.innerHTML.trim() !== "";
    if (!already) {
      paint();
      topupPopup.classList.add("pay-swap-in");
      openTopupBackdrop();
      return;
    }
    topupPopup.classList.remove("pay-swap-in");
    topupPopup.classList.add("pay-swap-out");
    topupSwapTimer = setTimeout(() => {
      topupPopup.classList.remove("pay-swap-out");
      paint();
      topupPopup.classList.add("pay-swap-in");
    }, 150);
  }

  function topupChoice(id, icon, title, subtitle) {
    return `
      <button class="pay-choice-card" type="button" data-topup-method="${id}">
        <span class="pay-choice-ico" aria-hidden="true">${icon}</span>
        <span><strong>${title}</strong><span class="hint">${subtitle}</span></span>
      </button>
    `;
  }

  function renderTopupAmount() {
    swapTopup(() => {
      topupPopup.innerHTML = `
        <div class="modal-top">
          <div>
            <div class="pill">Wallet top-up</div>
            <h3 id="topup-title">How much do you want to add?</h3>
            <p class="hint">Minimum GH\u20B5 5 \u00B7 Maximum GH\u20B5 5,000</p>
          </div>
          <button class="close-btn" type="button" data-close-topup aria-label="Close">×</button>
        </div>
        <form class="form pay-fields-in" id="topup-amount-form">
          <label>Amount (GH\u20B5)
            <input type="number" id="topup-amount" min="5" step="0.01" required placeholder="50" value="${escapeHtml(String(topup.amount || ""))}">
          </label>
          <label>Email for receipt
            <input type="email" id="topup-email" required placeholder="you@email.com" value="${escapeHtml(topup.email)}">
          </label>
          <p class="error" id="topup-popup-error" hidden></p>
          <button class="btn btn-primary btn-full" type="submit">Continue</button>
        </form>
      `;
      topupPopup.querySelector("[data-close-topup]").addEventListener("click", closeTopupPopup);
      topupPopup.querySelector("#topup-amount-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const amount = Number(topupPopup.querySelector("#topup-amount").value);
        const email = topupPopup.querySelector("#topup-email").value.trim();
        const error = topupPopup.querySelector("#topup-popup-error");
        if (!Number.isFinite(amount) || amount < 5) {
          error.hidden = false;
          error.textContent = "Enter at least GH\u20B5 5.";
          return;
        }
        topup.amount = amount;
        topup.email = email;
        renderTopupMethod();
      });
    });
  }

  function renderTopupMethod() {
    swapTopup(() => {
      topupPopup.innerHTML = `
        <div class="modal-top">
          <div>
            <div class="pill">Choose a way to pay</div>
            <h3 id="topup-title">Top up ${formatCedi(topup.amount)}</h3>
            <p class="hint">Pick Mobile Money or card</p>
          </div>
          <button class="close-btn" type="button" data-close-topup aria-label="Close">×</button>
        </div>
        <div class="pay-choice">
          ${topupChoice("momo", "📱", "Mobile Money", "MTN, Telecel Cash or AT Money")}
          ${topupChoice("card", "💳", "Debit or credit card", "Visa or Mastercard")}
        </div>
        <button class="btn btn-ghost btn-full" type="button" data-topup-back>Back</button>
      `;
      topupPopup.querySelector("[data-close-topup]").addEventListener("click", closeTopupPopup);
      topupPopup.querySelector("[data-topup-back]").addEventListener("click", renderTopupAmount);
      topupPopup.querySelectorAll("[data-topup-method]").forEach((btn) => {
        btn.addEventListener("click", () => {
          topup.method = btn.dataset.topupMethod;
          btn.classList.add("picked");
          setTimeout(renderTopupDetails, 180);
        });
      });
    });
  }

  function renderTopupDetails() {
    swapTopup(() => {
      const fields =
        topup.method === "card"
          ? `
            <label>Card number<input id="topup-card-number" inputmode="numeric" required placeholder="ACCT-000015" value="${escapeHtml(topup.card.number)}"></label>
            <div class="split card-expiry">
              <label>Month<input id="topup-card-month" maxlength="2" required placeholder="MM" value="${escapeHtml(topup.card.month)}"></label>
              <label>Year<input id="topup-card-year" maxlength="2" required placeholder="YY" value="${escapeHtml(topup.card.year)}"></label>
              <label>CVV<input id="topup-card-cvv" maxlength="4" required placeholder="123" value="${escapeHtml(topup.card.cvv)}"></label>
            </div>
          `
          : `
            <p class="hint" style="margin:0 0 6px">Pay with</p>
            <div class="pay-nets" id="topup-nets">
              <button class="pay-net mtn ${topup.provider === "mtn" ? "selected" : ""}" type="button" data-topup-provider="mtn"><span class="pay-net-mark">MTN</span><strong>MTN MoMo</strong></button>
              <button class="pay-net telecel ${topup.provider === "telecel" ? "selected" : ""}" type="button" data-topup-provider="telecel"><span class="pay-net-mark">TEL</span><strong>Telecel</strong></button>
              <button class="pay-net airteltigo ${topup.provider === "airteltigo" ? "selected" : ""}" type="button" data-topup-provider="airteltigo"><span class="pay-net-mark">AT</span><strong>AT Money</strong></button>
            </div>
            <label>MoMo number<input type="tel" id="topup-momo-phone" required placeholder="024 123 4567" value="${escapeHtml(topup.momoPhone)}"></label>
          `;
      topupPopup.innerHTML = `
        <div class="modal-top">
          <div>
            <div class="pill">${topup.method === "card" ? "Card" : "Mobile Money"}</div>
            <h3 id="topup-title">Pay ${formatCedi(topup.amount)}</h3>
            <p class="hint">You stay on DataLogs GH while Paystack confirms the charge.</p>
          </div>
          <button class="close-btn" type="button" data-close-topup aria-label="Close">×</button>
        </div>
        <form class="form pay-form pay-fields-in" id="topup-details-form">
          ${fields}
          <p class="error" id="topup-popup-error" hidden></p>
          <div class="hero-actions" style="margin-top:12px">
            <button class="btn btn-ghost" type="button" data-topup-back>Back</button>
            <button class="btn btn-primary btn-full" type="submit">Pay ${formatCedi(topup.amount)}</button>
          </div>
        </form>
      `;
      topupPopup.querySelector("[data-close-topup]").addEventListener("click", closeTopupPopup);
      topupPopup.querySelector("[data-topup-back]").addEventListener("click", renderTopupMethod);
      topupPopup.querySelectorAll("[data-topup-provider]").forEach((btn) => {
        btn.addEventListener("click", () => {
          topup.provider = btn.dataset.topupProvider;
          topupPopup.querySelectorAll("[data-topup-provider]").forEach((el) => el.classList.toggle("selected", el === btn));
        });
      });
      topupPopup.querySelector("#topup-details-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = topupPopup.querySelector("#topup-popup-error");
        error.hidden = true;
        try {
          if (topup.method === "momo") {
            topup.momoPhone = topupPopup.querySelector("#topup-momo-phone").value.trim();
            if (!topup.momoPhone.replace(/\D/g, "")) throw new Error("Enter the Mobile Money number that will pay.");
          } else {
            topup.card = {
              number: topupPopup.querySelector("#topup-card-number").value,
              month: topupPopup.querySelector("#topup-card-month").value,
              year: topupPopup.querySelector("#topup-card-year").value,
              cvv: topupPopup.querySelector("#topup-card-cvv").value,
            };
            if (String(topup.card.number).replace(/\D/g, "").length < 13) throw new Error("Enter a valid card number.");
          }
          await startTopupCharge();
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message || "Could not top up.";
        }
      });
    });
  }

  function renderTopupWait(title, hint) {
    swapTopup(() => {
      topupPopup.innerHTML = `
        <div class="modal-top">
          <div>
            <div class="pill">Wallet top-up</div>
            <h3 id="topup-title">${title}</h3>
            <p class="hint" id="topup-popup-hint">${hint}</p>
          </div>
        </div>
        <div class="pay-wait" aria-hidden="true"><i></i><i></i><i></i><div class="pay-wait-phone">₵</div></div>
        <p class="hint" style="text-align:center">Approve on your phone. Balance is added only after Paystack confirms.</p>
      `;
    });
  }

  function renderTopupChallenge() {
    const result = topup.challenge;
    const kind = result.next;
    const label = kind === "pin" ? "Card PIN" : kind === "otp" ? "Enter OTP" : "Phone number";
    swapTopup(() => {
      topupPopup.innerHTML = `
        <div class="pay-otp pay-fields-in">
          <div class="pay-wait" aria-hidden="true"><i></i><i></i><i></i><div class="pay-wait-phone">${kind === "pin" ? "🔒" : "🔑"}</div></div>
          <div class="pill">Almost there</div>
          <h3 id="topup-title">${label}</h3>
          <p class="hint">${result.display_text || "Confirm this charge to continue."}</p>
          <form class="form" id="topup-challenge-form">
            <input class="pay-otp-input" id="topup-challenge-input" required autocomplete="one-time-code" inputmode="numeric">
            <p class="error" id="topup-sheet-error" hidden></p>
            <button class="btn btn-primary btn-full" type="submit">Confirm payment</button>
          </form>
        </div>
      `;
      const input = topupPopup.querySelector("#topup-challenge-input");
      input.focus();
      topupPopup.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = topupPopup.querySelector("#topup-sheet-error");
        error.hidden = true;
        try {
          const next =
            kind === "pin"
              ? await DataLogsPay.submitPin(result.reference, input.value)
              : kind === "phone"
                ? await DataLogsPay.submitPhone(result.reference, input.value)
                : await DataLogsPay.submitOtp(result.reference, input.value);
          await handleTopupNext(next);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message || "Could not continue.";
        }
      });
    });
  }

  async function startTopupCharge() {
    if (!window.DataLogsPay) throw new Error("Payment is not loaded. Refresh and try again.");
    renderTopupWait("Confirming payment…", "Stay on this page while Paystack confirms the top-up.");
    try {
      const charged = await DataLogsPay.charge({
        kind: "wallet_topup",
        channel: topup.method,
        amount: topup.amount,
        email: topup.email,
        momo: { phone: topup.momoPhone, provider: topup.provider },
        card: {
          number: topup.card.number,
          cvv: topup.card.cvv,
          expiry_month: topup.card.month,
          expiry_year: topup.card.year,
        },
      });
      topup.reference = charged.reference;
      await handleTopupNext(charged);
    } catch (err) {
      const msg = err.message || "Could not top up.";
      const panelError = document.getElementById("topup-error");
      if (panelError) {
        panelError.hidden = false;
        panelError.textContent = msg;
      }
      swapTopup(() => {
        topupPopup.innerHTML = `
          <div class="modal-top">
            <div>
              <h3 id="topup-title">Could not complete payment</h3>
              <p class="error">${escapeHtml(msg)}</p>
            </div>
            <button class="close-btn" type="button" data-close-topup aria-label="Close">×</button>
          </div>
          <button class="btn btn-primary btn-full" type="button" data-topup-back>Try again</button>
        `;
        topupPopup.querySelector("[data-close-topup]").addEventListener("click", closeTopupPopup);
        topupPopup.querySelector("[data-topup-back]").addEventListener("click", renderTopupDetails);
      });
    }
  }

  async function waitForTopup(reference) {
    const success = document.getElementById("topup-success");
    const started = Date.now();
    while (Date.now() - started < 180000) {
      const status = await DataLogsPay.status(reference);
      if (status.status === "success") {
        swapTopup(() => {
          topupPopup.innerHTML = `
            <div class="success-mark" aria-hidden="true">✓</div>
            <h3 id="topup-title">Wallet topped up</h3>
            <p class="hint">${formatCedi(topup.amount)} is now in your wallet.</p>
            <button class="btn btn-primary btn-full" type="button" data-close-topup>Done</button>
          `;
          topupPopup.querySelector("[data-close-topup]").addEventListener("click", closeTopupPopup);
        });
        success.hidden = false;
        success.textContent = `Wallet topped up by ${formatCedi(topup.amount)}.`;
        topup.amount = "";
        topup.momoPhone = "";
        topup.card = { number: "", month: "", year: "", cvv: "" };
        await renderWallet();
        await renderOverview();
        return;
      }
      if (status.status === "failed" || status.status === "abandoned") {
        throw new Error("Payment was not completed.");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("Still waiting for Paystack. Check again in a minute.");
  }

  async function handleTopupNext(result) {
    if (result.url) window.open(String(result.url), "_blank", "noopener");
    if (result.next === "success") {
      renderTopupWait("Payment confirmed", "Adding money to your wallet…");
      await waitForTopup(result.reference);
      return;
    }
    if (result.next === "failed") throw new Error(result.display_text || "Payment failed.");
    if (result.next === "otp" || result.next === "pin" || result.next === "phone") {
      topup.challenge = result;
      renderTopupChallenge();
      return;
    }
    renderTopupWait("Approve on your phone", result.display_text || "Approve the payment, then wait here.");
    await waitForTopup(result.reference);
  }

  document.getElementById("open-topup")?.addEventListener("click", () => {
    const error = document.getElementById("topup-error");
    const success = document.getElementById("topup-success");
    if (error) error.hidden = true;
    if (success) success.hidden = true;
    topup.email = profile.email || profile.authEmail || topup.email;
    renderTopupAmount();
  });

  topupBackdrop?.addEventListener("click", (event) => {
    if (event.target === topupBackdrop) closeTopupPopup();
  });

  async function renderWithdrawals() {
    const [list, settings, wallet] = await Promise.all([
      DataLogsAPI.getWithdrawals(),
      DataLogsAPI.getSiteSettings().catch(() => null),
      DataLogsAPI.getWallet().catch(() => null),
    ]);
    const threshold = Number(settings?.withdrawal_threshold ?? 10);
    const hint = document.getElementById("withdraw-hint");
    const amountInput = document.getElementById("withdraw-amount");
    if (hint) {
      hint.textContent = `Withdraw your wallet profits to Mobile Money. Available ${formatCedi(
        wallet?.balance || 0
      )}. Minimum ${formatCedi(threshold)}. Admin must approve before money leaves your balance.`;
    }
    if (amountInput) {
      amountInput.min = String(threshold);
      amountInput.placeholder = String(threshold);
    }
    const body = document.getElementById("withdraw-body");
    const empty = document.getElementById("withdraw-empty");
    if (!list.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const netName = { mtn: "MTN", telecel: "Telecel", airteltigo: "AT" };
    body.innerHTML = list
      .map(
        (w) => `
      <tr>
        <td>${formatCedi(w.amount)}</td>
        <td>${w.momo_number}${w.account_name ? ` · ${escapeHtml(w.account_name)}` : ""}</td>
        <td>${netName[w.network] || w.network || "—"}</td>
        <td>${w.status}</td>
        <td>${new Date(w.created_at).toLocaleString()}</td>
      </tr>`
      )
      .join("");
  }

  async function renderApiKeys() {
    const base = document.getElementById("api-base-url");
    if (base) base.textContent = window.DATALOGS_CONFIG?.apiBase || "https://datalogsgh.shop/api/v1";
    const listEl = document.getElementById("api-key-list");
    if (!listEl) return;
    try {
      const keys = await DataLogsAPI.listApiKeys();
      const active = keys.filter((k) => !k.revoked_at);
      const retired = keys.filter((k) => k.revoked_at);
      if (!keys.length) {
        listEl.innerHTML = `<div class="empty-state">No keys yet. Generate one above, then follow the API docs.</div>`;
        return;
      }
      listEl.innerHTML = [...active, ...retired]
        .map((k) => {
          const revoked = !!k.revoked_at;
          return `
          <article class="user-card">
            <div>
              <div class="user-card-name">${escapeHtml(k.name || "Website")} ${revoked ? `<span class="badge-blocked">Revoked</span>` : ""}</div>
              <p class="user-card-meta"><code>${escapeHtml(k.key_prefix)}…</code> · created ${new Date(k.created_at).toLocaleDateString()}${
                k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : " · not used yet"
              }</p>
            </div>
            ${
              revoked
                ? ""
                : `<button class="btn btn-danger" type="button" data-revoke-key="${k.id}">Revoke</button>`
            }
          </article>`;
        })
        .join("");
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message || "Could not load API keys.")}</div>`;
    }
  }

  document.getElementById("api-key-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("api-key-error");
    const reveal = document.getElementById("api-key-reveal");
    error.hidden = true;
    reveal.hidden = true;
    const name = new FormData(event.target).get("name");
    try {
      const created = await DataLogsAPI.createApiKey(String(name || "Website"));
      reveal.hidden = false;
      reveal.innerHTML = `
        <strong>Copy this key now. It will not be shown again.</strong>
        <code id="new-api-key">${escapeHtml(created.key)}</code>
        <button class="btn btn-primary" type="button" id="copy-api-key">Copy key</button>`;
      document.getElementById("copy-api-key").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(created.key);
          document.getElementById("copy-api-key").textContent = "Copied";
        } catch {
          document.getElementById("new-api-key").focus();
        }
      });
      await renderApiKeys();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not create key.";
    }
  });

  document.getElementById("api-key-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-revoke-key]");
    if (!btn) return;
    if (!confirm("Revoke this API key? Websites using it will stop working.")) return;
    try {
      await DataLogsAPI.revokeApiKey(btn.dataset.revokeKey);
      await renderApiKeys();
    } catch (err) {
      alert(err.message || "Could not revoke key.");
    }
  });

  let flyerStyle = "shop";
  const flyerPhone = document.getElementById("flyer-phone");
  const flyerHours = document.getElementById("flyer-hours");
  if (flyerPhone) flyerPhone.value = profile.phone || "";

  function prettyPhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    let local = digits;
    if (local.startsWith("233") && local.length === 12) local = `0${local.slice(3)}`;
    if (local.length === 9) local = `0${local}`;
    if (local.length === 10) return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
    return String(raw || "").trim();
  }

  function intlPhone(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.startsWith("0") && digits.length === 10) digits = `233${digits.slice(1)}`;
    if (digits.startsWith("233") && digits.length === 12) {
      return `+233 (0) ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }
    return prettyPhone(raw);
  }

  function storeLink(slug) {
    const base = (window.DATALOGS_CONFIG?.siteUrl || "https://datalogsgh.shop").replace(/\/$/, "");
    if (slug) return `${base}/store.html?s=${encodeURIComponent(slug)}`;
    return base;
  }

  function flyerPackages() {
    const networks = storeCache?.networks || ["mtn", "airteltigo", "telecel"];
    return packages
      .filter((p) => networks.includes(p.network) && priceMap.has(p.id))
      .map((p) => ({
        network: p.network,
        gb: p.gb,
        price: Number(p.agentPrice) + Number(priceMap.get(p.id) || 0),
      }));
  }

  function websiteAccent() {
    const id = document.documentElement.getAttribute("data-accent") || window.DataLogsTheme?.currentAccent?.() || "sea";
    const found = window.DataLogsTheme?.ACCENTS?.find((a) => a.id === id);
    const css = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return found?.hex || css || "#2ec8e6";
  }

  function flyerPayload() {
    const store = storeCache;
    const slug = store?.slug;
    return {
      name: store?.name || profile.full_name || "My Data Hub",
      tagline: store?.tagline || "Your Trusted Data Plug",
      phone: prettyPhone(flyerPhone?.value || profile.phone || ""),
      phoneIntl: intlPhone(flyerPhone?.value || profile.phone || ""),
      hours: flyerHours?.value || "8am - 9pm Each day",
      url: storeLink(slug),
      packages: flyerPackages(),
      accent: window.DataLogsTheme?.accentHex?.(store?.accent_color) || websiteAccent(),
    };
  }

  async function renderFlyerPreview() {
    const error = document.getElementById("flyer-error");
    const hint = document.getElementById("flyer-url-hint");
    const canvas = document.getElementById("flyer-canvas");
    if (!canvas || !window.DataLogsFlyer) return;
    error.hidden = true;
    if (!storeCache) {
      error.hidden = false;
      error.textContent = "Save your mini store first, then generate a flyer.";
    } else if (!flyerPackages().length) {
      error.hidden = false;
      error.textContent = "Set store prices first. Only priced packages appear on the flyer.";
    }
    const data = flyerPayload();
    if (hint) hint.textContent = `Caption: ${data.url}`;
    try {
      await DataLogsFlyer.render(canvas, flyerStyle, data);
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not draw the flyer.";
    }
  }

  document.getElementById("flyer-styles")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-flyer-style]");
    if (!btn) return;
    flyerStyle = btn.dataset.flyerStyle;
    document.querySelectorAll("#flyer-styles .flyer-style").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderFlyerPreview();
  });

  document.getElementById("flyer-preview-btn")?.addEventListener("click", () => renderFlyerPreview());
  document.getElementById("flyer-phone")?.addEventListener("change", () => renderFlyerPreview());
  document.getElementById("flyer-hours")?.addEventListener("change", () => renderFlyerPreview());

  document.getElementById("flyer-download-btn")?.addEventListener("click", async () => {
    const canvas = document.getElementById("flyer-canvas");
    const error = document.getElementById("flyer-error");
    error.hidden = true;
    if (!storeCache) {
      error.hidden = false;
      error.textContent = "Save your mini store first, then download a flyer.";
      return;
    }
    try {
      await renderFlyerPreview();
      const slug = storeCache.slug || "store";
      await DataLogsFlyer.download(canvas, `${slug}-${flyerStyle}-flyer.jpg`);
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not download the flyer.";
    }
  });

  new MutationObserver(() => {
    const panel = document.querySelector('[data-panel-view="flyer"]');
    if (panel?.classList.contains("active")) renderFlyerPreview();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent"] });

  // Overview labels already set in HTML
  try {
    packages = await DataLogsAPI.fetchPackages();
    window.__PACKAGES = packages;
    const prices = await DataLogsAPI.getAgentStorePrices(profile.id);
    priceMap = new Map(prices.map((p) => [p.package_id, Number(p.profit)]));
    await refreshStoreUI();
  } catch (err) {
    console.error(err);
  }
  try {
    await renderOverview();
  } catch (err) {
    console.error(err);
  }
  startLiveOverview();
  updateMarkupCopy();
  renderPricing();
  renderWholesale();
  renderFlyerPreview();
  await renderOrders();
  await renderCustomers();
  await renderWallet();
  await renderWithdrawals();
  await renderApiKeys();
})();
