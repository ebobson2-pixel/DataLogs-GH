(function homeMotion() {
  if (!document.body.classList.contains("home-page")) return;

  const nodes = document.querySelectorAll(
    ".home-networks .reveal, .home-buy-data .reveal, .home-why .reveal, .home-cta-section .reveal, .home-buy-again .reveal"
  );
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -40px 0px" }
    );
    nodes.forEach((el) => io.observe(el));
  } else {
    nodes.forEach((el) => el.classList.add("in-view"));
  }

  document.getElementById("home-track-btn")?.addEventListener("click", () => {
    window.DataLogsTrack?.open?.();
  });

  function recentCard(item) {
    const net = NETWORKS[item.network]?.name || item.network;
    return `
      <button class="card package-card package-card--${item.network} buy-again-card" type="button" data-buy-again-card="${item.packageId}" data-recipient="${escapeHtml(item.recipient || "")}" data-tier="${escapeHtml(item.tier || "retail")}" data-store="${item.storeId || ""}">
        <div class="pill">${net}</div>
        <div class="gb">${item.gb}<span> GB</span></div>
        <div class="meta">${escapeHtml(item.recipient || "Saved order")}</div>
        <div class="price">${formatCedi(item.price)}</div>
        <div class="tap-hint">Buy again &rarr;</div>
      </button>`;
  }

  function paintRecent() {
    const section = document.getElementById("home-buy-again");
    const grid = document.getElementById("home-recent-orders");
    const recent = window.DataLogsCustomer?.getRecentOrders?.() || [];
    if (!section || !grid || !recent.length) return;
    section.hidden = false;
    grid.innerHTML = recent.slice(0, 4).map(recentCard).join("");
    grid.querySelectorAll("[data-buy-again-card]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.DataLogsCustomer?.buyAgain?.({
          packageId: btn.dataset.buyAgainCard,
          recipient: btn.dataset.recipient,
          tier: btn.dataset.tier,
          storeId: btn.dataset.store || null,
        });
      });
    });
  }

  async function waitForPackages() {
    for (let i = 0; i < 40; i++) {
      if (window.__PACKAGES?.length) return window.__PACKAGES;
      await new Promise((r) => setTimeout(r, 100));
    }
    return window.__PACKAGES || [];
  }

  async function paintPackageTeaser() {
    const el = document.getElementById("home-package-teaser");
    if (!el) return;
    const pkgs = await waitForPackages();
    if (!pkgs.length) {
      el.innerHTML = `<p class="hint">Data packages are available on the Buy data page.</p>`;
      return;
    }
    const nets = ["mtn", "airteltigo", "telecel"];
    el.innerHTML = nets
      .map((netId) => {
        const list = pkgs.filter((p) => p.network === netId);
        if (!list.length) return "";
        const from = Math.min(...list.map((p) => Number(p.price)));
        const maxGb = Math.max(...list.map((p) => Number(p.gb)));
        const net = NETWORKS[netId]?.name || netId;
        return `
          <a class="home-teaser-card home-teaser-card--${netId}" href="packages.html?network=${netId}">
            <span class="pill">${net}</span>
            <strong>${list.length} package${list.length === 1 ? "" : "s"}</strong>
            <span class="hint">From ${formatCedi(from)} · up to ${maxGb}GB</span>
            <span class="tap-hint">View on Buy data &rarr;</span>
          </a>`;
      })
      .filter(Boolean)
      .join("");
    if (!el.innerHTML.trim()) {
      el.innerHTML = `<p class="hint">Packages are listed on the Buy data page.</p>`;
    }
  }

  paintRecent();
  paintPackageTeaser();
  window.addEventListener("datalogs:order-placed", paintRecent);
})();
