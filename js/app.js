(async function initSite() {
  const Theme = window.DataLogsTheme;
  const page = document.body.dataset.page || "home";
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");
  const assetPrefix = document.body.dataset.assetPrefix || "";
  const logoMark = `<span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="16" fill="currentColor"/><path d="M18 40c6.5-6.5 15.5-6.5 22 0" stroke="#0b0b0b" stroke-width="4.5" stroke-linecap="round"/><path d="M13 33c10-10 28-10 38 0" stroke="#0b0b0b" stroke-width="4.5" stroke-linecap="round" opacity="0.72"/><path d="M9 26c13.5-13.5 32.5-13.5 46 0" stroke="#0b0b0b" stroke-width="4.5" stroke-linecap="round" opacity="0.42"/><circle cx="32" cy="46" r="4.2" fill="#0b0b0b"/></svg></span>`;

  if (Theme) {
    Theme.applyTheme(Theme.currentTheme());
    Theme.applyAccent(Theme.currentAccent());
  }

  if (header) {
    header.innerHTML = `
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="site-header">
        <div class="wrap nav">
          <a class="logo" href="${assetPrefix}index.html" aria-label="DataLogs GH home">
            ${logoMark}
            <span class="brand-word">DataLogs</span> <span>GH</span>
          </a>
          <div class="nav-end">
            <nav class="nav-links" id="primary-nav" aria-label="Primary">
              <a href="${assetPrefix}index.html" data-nav="home">Home</a>
              <a href="${assetPrefix}packages.html" data-nav="packages">Packages</a>
              <a href="${assetPrefix}track.html" data-nav="track">Track order</a>
              <a href="${assetPrefix}how-it-works.html" data-nav="how">How it works</a>
              <a href="${assetPrefix}docs.html" data-nav="docs">API docs</a>
              <a href="${assetPrefix}about.html" data-nav="about">About</a>
              <a href="${assetPrefix}contact.html" data-nav="contact">Contact</a>
              <a href="${assetPrefix}customer/auth.html" data-nav="account">Sign in</a>
              <a href="${assetPrefix}agent/auth.html" data-nav="agent">Agents</a>
              <a class="btn btn-primary" href="${assetPrefix}packages.html">Buy data</a>
            </nav>
            <div class="nav-tools">
              ${Theme ? Theme.toolsHTML() : ""}
              <button class="menu-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="primary-nav">
                <span class="menu-toggle-bars" aria-hidden="true">
                  <span></span><span></span><span></span>
                </span>
              </button>
            </div>
          </div>
          <div class="nav-scrim" hidden></div>
        </div>
      </header>
    `;

    header.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === page) link.classList.add("active");
    });

    if (Theme) Theme.bind(header.querySelector(".nav-tools"));

    const toggle = header.querySelector(".menu-toggle");
    const links = header.querySelector(".nav-links");
    const scrim = header.querySelector(".nav-scrim");

    const setMenuOpen = (open) => {
      links.classList.toggle("open", open);
      scrim.classList.toggle("open", open);
      scrim.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      document.body.classList.toggle("nav-open", open);
    };

    toggle.addEventListener("click", () => {
      setMenuOpen(!links.classList.contains("open"));
    });
    scrim.addEventListener("click", () => setMenuOpen(false));
    links.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setMenuOpen(false));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    });
  }

  if (footer) {
    footer.innerHTML = `
      <footer class="site-footer">
        <div class="wrap footer-grid">
          <div>
            <div class="logo">${logoMark} DataLogs <span>GH</span></div>
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
            <p><a href="${assetPrefix}docs.html">Agent API docs</a></p>
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
          <span>&copy; ${new Date().getFullYear()} DataLogs GH.</span>
          <span class="footer-powered">POWERED BY FSTech</span>
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

  const searchInput = document.getElementById("package-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll("[data-packages]").forEach((grid) => {
        if (!q) {
          renderPackages(grid, grid.dataset.packages, Number(grid.dataset.limit || 0));
          return;
        }
        const list = sortPackages(
          packagesFor(grid.dataset.packages === "all" ? "all" : grid.dataset.packages).filter((p) => {
            const hay = `${NETWORKS[p.network]?.name || p.network} ${p.gb}gb ${p.validity} ${p.price}`.toLowerCase();
            return hay.includes(q);
          })
        );
        grid.classList.remove("package-groups");
        grid.classList.add("package-grid");
        grid.innerHTML = list.length
          ? list.map(packageCardHTML).join("")
          : `<p class="hint">No packages match “${escapeHtml(q)}”.</p>`;
      });
    });
  }

  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    group.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
        btn.classList.add("active");
        const grid = document.querySelector(group.dataset.filterGroup);
        if (grid) renderPackages(grid, btn.dataset.filter, Number(grid.dataset.limit || 0));
      });
    });
  });
})();

const NETWORK_ORDER = ["mtn", "airteltigo", "telecel"];

function sortPackages(list) {
  return [...list].sort((a, b) => {
    const orderDiff = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    if (orderDiff !== 0) return orderDiff;
    return Number(a.gb) - Number(b.gb);
  });
}

function packageCardHTML(item) {
  return `
      <button class="card package-card package-card--${item.network}" type="button" data-buy="${item.id}" data-tier="retail">
        ${item.tag ? `<span class="tag">${item.tag}</span>` : ""}
        <div class="pill">${NETWORKS[item.network].name}</div>
        <div class="gb">${item.gb}<span> GB</span></div>
        <div class="meta">${item.validity} &middot; Instant send</div>
        <div class="price">${formatCedi(item.price)}</div>
        <div class="tap-hint">Tap to buy &rarr;</div>
      </button>
    `;
}

function renderPackages(grid, network, limit) {
  const perNetworkLimit = Number(grid.dataset.limitPerNetwork || 0);
  const useGrouped =
    network === "all" &&
    (grid.dataset.grouped !== undefined || grid.id === "all-packages");

  if (useGrouped) {
    grid.classList.add("package-groups");
    grid.classList.remove("package-grid");
    const sections = NETWORK_ORDER.map((netId) => {
      let list = sortPackages(packagesFor(netId));
      const cap = perNetworkLimit || limit || 0;
      if (cap > 0) list = list.slice(0, cap);
      if (!list.length) return "";
      const net = NETWORKS[netId];
      return `
        <section class="network-packages-section network-packages-section--${netId}">
          <div class="network-packages-head">
            <span class="pill">${net.name}</span>
            <h3>${net.name} bundles</h3>
            <p class="hint">${net.blurb}</p>
          </div>
          <div class="package-grid">
            ${list.map(packageCardHTML).join("")}
          </div>
        </section>
      `;
    }).filter(Boolean);

    grid.innerHTML = sections.length
      ? sections.join("")
      : `<p class="hint">No packages available right now.</p>`;
    return;
  }

  grid.classList.remove("package-groups");
  grid.classList.add("package-grid");
  let list = sortPackages(packagesFor(network));
  if (limit > 0) list = list.slice(0, limit);
  if (!list.length) {
    grid.innerHTML = `<p class="hint">No packages available right now.</p>`;
    return;
  }
  grid.innerHTML = list.map(packageCardHTML).join("");
}
