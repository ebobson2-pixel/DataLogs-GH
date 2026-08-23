(function homeMotion() {
  if (!document.body.classList.contains("home-page")) return;

  const nodes = document.querySelectorAll(
    ".home-networks .reveal, .home-packages .reveal, .home-trending .reveal, .home-why .reveal, .home-cta-section .reveal, .home-buy-again .reveal"
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

  async function paintTrending() {
    const grid = document.getElementById("home-trending");
    if (!grid || !window.DataLogsAPI?.trendingPackages) return;
    try {
      const rows = await DataLogsAPI.trendingPackages(6);
      if (!rows.length) {
        document.querySelector(".home-trending")?.remove();
        return;
      }
      grid.innerHTML = rows
        .map((row) => {
          const pkg =
            window.__PACKAGES?.find((p) => p.id === row.package_id) ||
            mapPackage({
              id: row.package_id,
              network: row.network,
              gb: row.gb,
              retail_price: row.retail_price,
              agent_price: row.retail_price,
              validity: row.validity,
              active: true,
            });
          return packageCardHTML(pkg);
        })
        .join("");
    } catch {
      document.querySelector(".home-trending")?.remove();
    }
  }

  paintRecent();
  paintTrending();
  window.addEventListener("datalogs:order-placed", paintRecent);
})();
