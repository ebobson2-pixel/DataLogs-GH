window.DataLogsNotify = (() => {
  const state = {
    open: false,
    prefsOpen: false,
    loading: false,
    error: "",
    items: [],
    unread: 0,
    filter: "all",
    prefs: null,
    pollTimer: null,
    channel: null,
  };

  const ICONS = {
    order: "📦",
    payment: "💳",
    wallet: "💰",
    refund: "↩️",
    dispute: "⚖️",
    security: "🔐",
    system: "📢",
    promotion: "✨",
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (sec < 60) return "Just now";
    if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
    if (sec < 172800) return "Yesterday";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yday = new Date();
    yday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yday.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function resolveActionUrl(item) {
    const raw = item?.action_url || "";
    if (!raw) return null;
    try {
      return new URL(raw, window.location.href).href;
    } catch {
      return raw;
    }
  }

  function mountShell(anchor) {
    if (!anchor || document.getElementById("dl-notify-root")) return;
    const root = document.createElement("div");
    root.id = "dl-notify-root";
    root.className = "dl-notify-root";
    root.innerHTML = `
      <button class="dl-notify-bell" type="button" id="dl-notify-bell" aria-label="Notifications" aria-expanded="false">
        <span aria-hidden="true">🔔</span>
        <span class="dl-notify-badge" id="dl-notify-badge" hidden>0</span>
      </button>
      <div class="dl-notify-scrim" id="dl-notify-scrim" hidden></div>
      <div class="dl-notify-panel" id="dl-notify-panel" hidden role="dialog" aria-label="Notifications">
        <div class="dl-notify-head">
          <div>
            <h3>Notifications</h3>
            <p class="dl-notify-sub">Orders, payments, wallet &amp; account updates</p>
          </div>
          <div class="dl-notify-head-actions">
            <button type="button" class="dl-notify-text-btn" id="dl-notify-prefs-btn">Settings</button>
            <button type="button" class="dl-notify-text-btn" id="dl-notify-readall">Mark all read</button>
            <button type="button" class="dl-notify-close" id="dl-notify-close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="dl-notify-filters" id="dl-notify-filters">
          <button type="button" class="dl-notify-chip active" data-filter="all">All</button>
          <button type="button" class="dl-notify-chip" data-filter="unread">Unread</button>
          <button type="button" class="dl-notify-chip" data-filter="order">Orders</button>
          <button type="button" class="dl-notify-chip" data-filter="payment">Payments</button>
          <button type="button" class="dl-notify-chip" data-filter="wallet">Wallet</button>
          <button type="button" class="dl-notify-chip" data-filter="refund">Refunds</button>
        </div>
        <div class="dl-notify-body" id="dl-notify-body">
          <div class="dl-notify-loading">Loading notifications…</div>
        </div>
        <div class="dl-notify-prefs" id="dl-notify-prefs" hidden></div>
      </div>
    `;
    anchor.appendChild(root);

    root.querySelector("#dl-notify-bell").addEventListener("click", togglePanel);
    root.querySelector("#dl-notify-close").addEventListener("click", closePanel);
    root.querySelector("#dl-notify-scrim").addEventListener("click", closePanel);
    root.querySelector("#dl-notify-readall").addEventListener("click", markAllRead);
    root.querySelector("#dl-notify-prefs-btn").addEventListener("click", togglePrefs);
    root.querySelector("#dl-notify-filters").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-filter]");
      if (!chip) return;
      state.filter = chip.dataset.filter;
      root.querySelectorAll(".dl-notify-chip").forEach((el) => el.classList.toggle("active", el === chip));
      paintList();
      refresh({ silent: true });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) closePanel();
    });
  }

  function setBadge(count) {
    state.unread = Number(count) || 0;
    const badge = document.getElementById("dl-notify-badge");
    if (!badge) return;
    if (state.unread > 0) {
      badge.hidden = false;
      badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
    } else {
      badge.hidden = true;
    }
  }

  function paintList() {
    const body = document.getElementById("dl-notify-body");
    const prefs = document.getElementById("dl-notify-prefs");
    if (!body) return;

    if (state.prefsOpen) {
      body.hidden = true;
      if (prefs) prefs.hidden = false;
      return;
    }
    body.hidden = false;
    if (prefs) prefs.hidden = true;

    if (state.loading && !state.items.length) {
      body.innerHTML = `<div class="dl-notify-loading">Loading notifications…</div>`;
      return;
    }
    if (state.error) {
      body.innerHTML = `
        <div class="dl-notify-empty">
          <strong>Couldn't load your notifications.</strong>
          <p>${escapeHtml(state.error)}</p>
          <button type="button" class="btn btn-primary btn-sm" id="dl-notify-retry">Try again</button>
        </div>`;
      body.querySelector("#dl-notify-retry")?.addEventListener("click", () => refresh());
      return;
    }

    let items = state.items.slice();
    if (state.filter === "unread") items = items.filter((i) => i.unread);
    else if (state.filter !== "all") items = items.filter((i) => i.category === state.filter);

    if (!items.length) {
      body.innerHTML = `
        <div class="dl-notify-empty">
          <div class="dl-notify-empty-ico">🔔</div>
          <strong>You're all caught up.</strong>
          <p>New order, payment, wallet, and account updates will appear here.</p>
        </div>`;
      return;
    }

    let lastDay = "";
    body.innerHTML = items
      .map((item) => {
        const day = dayLabel(item.created_at);
        const dayHtml = day !== lastDay ? `<div class="dl-notify-day">${escapeHtml(day)}</div>` : "";
        lastDay = day;
        const icon = ICONS[item.category] || "🔔";
        const url = resolveActionUrl(item) || "";
        return `
          ${dayHtml}
          <button type="button" class="dl-notify-item ${item.unread ? "is-unread" : ""} priority-${escapeHtml(item.priority || "normal")}"
            data-id="${escapeHtml(item.id)}" data-source="${escapeHtml(item.source || "personal")}" data-url="${escapeHtml(url)}">
            <span class="dl-notify-item-ico" aria-hidden="true">${icon}</span>
            <span class="dl-notify-item-main">
              <span class="dl-notify-item-title">${escapeHtml(item.title)}</span>
              <span class="dl-notify-item-body">${escapeHtml(item.body)}</span>
              <span class="dl-notify-item-meta">
                <span class="dl-notify-cat">${escapeHtml(item.category || "system")}</span>
                <span>${escapeHtml(relativeTime(item.created_at))}</span>
              </span>
            </span>
            ${item.unread ? '<span class="dl-notify-dot" aria-hidden="true"></span>' : ""}
          </button>`;
      })
      .join("");

    body.querySelectorAll(".dl-notify-item").forEach((btn) => {
      btn.addEventListener("click", () => openItem(btn.dataset.id, btn.dataset.source, btn.dataset.url));
    });
  }

  function prefRow(key, label, on) {
    return `
      <label class="dl-notify-pref-row">
        <span>${escapeHtml(label)}</span>
        <input type="checkbox" data-pref="${key}" ${on ? "checked" : ""}>
      </label>`;
  }

  async function paintPrefs() {
    const box = document.getElementById("dl-notify-prefs");
    if (!box) return;
    try {
      state.prefs = await DataLogsAPI.getNotificationPreferences();
    } catch (err) {
      box.innerHTML = `<div class="dl-notify-empty"><p>${escapeHtml(err.message || "Could not load settings.")}</p></div>`;
      return;
    }
    const p = state.prefs || {};
    box.innerHTML = `
      <div class="dl-notify-prefs-inner">
        <h4>Notification settings</h4>
        <p class="hint">Security alerts always stay on.</p>
        ${prefRow("order_updates", "Order updates", p.order_updates)}
        ${prefRow("payment_updates", "Payment updates", p.payment_updates)}
        ${prefRow("wallet_activity", "Wallet activity", p.wallet_activity)}
        ${prefRow("refund_updates", "Refund updates", p.refund_updates)}
        ${prefRow("dispute_updates", "Dispute updates", p.dispute_updates)}
        ${prefRow("promotional", "Promotional notifications", p.promotional)}
        <div class="dl-notify-prefs-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="dl-prefs-back">Back</button>
          <button type="button" class="btn btn-primary btn-sm" id="dl-prefs-save">Save</button>
        </div>
      </div>`;
    box.querySelector("#dl-prefs-back").addEventListener("click", () => {
      state.prefsOpen = false;
      paintList();
    });
    box.querySelector("#dl-prefs-save").addEventListener("click", async () => {
      const next = {};
      box.querySelectorAll("[data-pref]").forEach((el) => {
        next[el.dataset.pref] = el.checked;
      });
      try {
        await DataLogsAPI.updateNotificationPreferences(next);
        state.prefsOpen = false;
        await refresh();
      } catch (err) {
        alert(err.message || "Could not save preferences.");
      }
    });
  }

  async function openItem(id, source, url) {
    try {
      await DataLogsAPI.markNotificationRead(id, source || "personal");
    } catch {
      /* still navigate */
    }
    const item = state.items.find((x) => x.id === id);
    if (item) {
      item.unread = false;
      item.read_at = item.read_at || new Date().toISOString();
    }
    setBadge(Math.max(0, state.unread - 1));
    paintList();
    if (url) {
      closePanel();
      window.location.href = url;
    }
  }

  async function markAllRead() {
    try {
      await DataLogsAPI.markAllNotificationsRead();
      state.items.forEach((i) => {
        i.unread = false;
        i.read_at = i.read_at || new Date().toISOString();
      });
      setBadge(0);
      paintList();
    } catch (err) {
      alert(err.message || "Could not mark all as read.");
    }
  }

  function togglePrefs() {
    state.prefsOpen = !state.prefsOpen;
    if (state.prefsOpen) {
      document.getElementById("dl-notify-body").hidden = true;
      document.getElementById("dl-notify-prefs").hidden = false;
      paintPrefs();
    } else {
      paintList();
    }
  }

  function openPanel() {
    state.open = true;
    document.getElementById("dl-notify-panel").hidden = false;
    document.getElementById("dl-notify-scrim").hidden = false;
    document.getElementById("dl-notify-bell").setAttribute("aria-expanded", "true");
    refresh();
  }

  function closePanel() {
    state.open = false;
    state.prefsOpen = false;
    document.getElementById("dl-notify-panel").hidden = true;
    document.getElementById("dl-notify-scrim").hidden = true;
    document.getElementById("dl-notify-bell").setAttribute("aria-expanded", "false");
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  async function refresh({ silent = false } = {}) {
    if (!window.DataLogsAPI?.listNotifications) return;
    if (!silent) {
      state.loading = true;
      state.error = "";
      paintList();
    }
    try {
      const category = ["order", "payment", "wallet", "refund"].includes(state.filter) ? state.filter : null;
      const unreadOnly = state.filter === "unread";
      const data = await DataLogsAPI.listNotifications({
        limit: 40,
        category,
        unreadOnly,
      });
      state.items = Array.isArray(data.items) ? data.items : [];
      setBadge(Number(data.unread || 0));
      state.error = "";
    } catch (err) {
      state.error = err.message || "Something went wrong.";
    } finally {
      state.loading = false;
      if (state.open) paintList();
    }
  }

  async function refreshBadgeOnly() {
    try {
      const count = await DataLogsAPI.unreadNotificationCount();
      setBadge(count);
    } catch {
      /* ignore */
    }
  }

  function startRealtime() {
    try {
      const client = DataLogsAPI.client;
      if (!client?.channel) return;
      state.channel = client
        .channel(`dl-notifications-${Date.now()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notifications" },
          () => {
            refreshBadgeOnly();
            if (state.open) refresh({ silent: true });
          }
        )
        .subscribe();
    } catch {
      /* Realtime optional */
    }
    state.pollTimer = setInterval(() => {
      refreshBadgeOnly();
      if (state.open) refresh({ silent: true });
    }, 45000);
  }

  async function init(anchorSelector) {
    if (!window.DataLogsAPI) return null;
    const profile = await DataLogsAPI.getProfile().catch(() => null);
    if (!profile) return null;
    const anchor =
      typeof anchorSelector === "string"
        ? document.querySelector(anchorSelector)
        : anchorSelector ||
          document.querySelector(".dash-topbar-end") ||
          document.querySelector(".customer-dash-head") ||
          document.querySelector(".hero-actions");
    if (!anchor) return null;
    mountShell(anchor);
    await refreshBadgeOnly();
    startRealtime();
    return state;
  }

  return { init, refresh, openPanel, closePanel };
})();
