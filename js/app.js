(async function initSite() {
  const page = document.body.dataset.page || "home";
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");
  const assetPrefix = document.body.dataset.assetPrefix || "";

  if (header) {
    header.innerHTML = `
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="site-header">
        <div class="wrap nav">
          <a class="logo" href="${assetPrefix}index.html" aria-label="DataLogs GH home">
            <span class="logo-mark">DL</span>
            DataLogs <span>GH</span>
          </a>
          <button class="menu-toggle" type="button" aria-label="Open menu">☰</button>
          <nav class="nav-links" aria-label="Primary">
            <a href="${assetPrefix}index.html" data-nav="home">Home</a>
            <a href="${assetPrefix}packages.html" data-nav="packages">Packages</a>
            <a href="${assetPrefix}how-it-works.html" data-nav="how">How it works</a>
            <a href="${assetPrefix}about.html" data-nav="about">About</a>
            <a href="${assetPrefix}contact.html" data-nav="contact">Contact</a>
            <a href="${assetPrefix}agent/auth.html" data-nav="agent">Agents</a>
            <a class="btn btn-primary" href="${assetPrefix}packages.html">Buy data</a>
          </nav>
        </div>
      </header>
    `;

    header.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === page) link.classList.add("active");
    });

    const toggle = header.querySelector(".menu-toggle");
    const links = header.querySelector(".nav-links");
    toggle.addEventListener("click", () => links.classList.toggle("open"));
  }

  if (footer) {
    footer.innerHTML = `
      <footer class="site-footer">
        <div class="wrap footer-grid">
          <div>
            <div class="logo"><span class="logo-mark">DL</span> DataLogs <span>GH</span></div>
            <p class="intro">Sea blue and black, simple and fast. Buy MTN, AirtelTigo and Telecel data in Ghana without the long queues.</p>
          </div>
          <div>
            <strong>Shop</strong>
            <p><a href="${assetPrefix}mtn.html">MTN bundles</a></p>
            <p><a href="${assetPrefix}airteltigo.html">AirtelTigo bundles</a></p>
            <p><a href="${assetPrefix}telecel.html">Telecel bundles</a></p>
          </div>
          <div>
            <strong>Company</strong>
            <p><a href="${assetPrefix}about.html">About us</a></p>
            <p><a href="${assetPrefix}how-it-works.html">How it works</a></p>
            <p><a href="${assetPrefix}contact.html">Support</a></p>
            <p><a href="${assetPrefix}agent/auth.html">Become an agent</a></p>
          </div>
          <div>
            <strong>Hours</strong>
            <p>Orders sync live to DataLogs GH.</p>
            <p>Accra, Ghana</p>
          </div>
        </div>
        <div class="wrap footer-bottom">
          <span>© ${new Date().getFullYear()} DataLogs GH.</span>
          <span>Powered by Supabase.</span>
        </div>
      </footer>
    `;
  }

  try {
    window.__PACKAGES = await DataLogsAPI.fetchPackages();
  } catch (err) {
    console.error(err);
    window.__PACKAGES = [];
    document.querySelectorAll("[data-packages]").forEach((grid) => {
      grid.innerHTML = `<p class="error">Could not load packages. Check your connection.</p>`;
    });
    return;
  }

  document.querySelectorAll("[data-packages]").forEach((grid) => {
    renderPackages(grid, grid.dataset.packages, Number(grid.dataset.limit || 0));
  });

  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    group.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
        btn.classList.add("active");
        const grid = document.querySelector(group.dataset.filterGroup);
        if (grid) renderPackages(grid, btn.dataset.filter);
      });
    });
  });
})();

function renderPackages(grid, network, limit) {
  const list = packagesFor(network).slice(0, limit || undefined);
  if (!list.length) {
    grid.innerHTML = `<p class="hint">No packages available right now.</p>`;
    return;
  }
  grid.innerHTML = list
    .map(
      (item) => `
      <button class="card package-card package-card--${item.network}" type="button" data-buy="${item.id}" data-tier="retail">
        ${item.tag ? `<span class="tag">${item.tag}</span>` : ""}
        <div class="pill">${NETWORKS[item.network].name}</div>
        <div class="gb">${item.gb}<span> GB</span></div>
        <div class="meta">${item.validity} · Instant send</div>
        <div class="price">${formatCedi(item.price)}</div>
        <div class="tap-hint">Tap to buy →</div>
      </button>
    `
    )
    .join("");
}
