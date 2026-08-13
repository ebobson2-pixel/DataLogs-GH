(async function adminDashboard() {
  const profile = await DataLogsAPI.requireProfile(["admin"], "../agent/auth.html");
  if (!profile) return;

  const shell = document.getElementById("dash-shell");
  const titles = {
    overview: ["Overview", "Control center"],
    packages: ["Packages", "Retail & agent pricing"],
    orders: ["Orders", "Payments and delivery"],
    users: ["Users", "Roles and access"],
    stores: ["Stores", "Agent mini storefronts"],
  };

  document.getElementById("user-name").textContent = profile.full_name || "Admin";
  document.getElementById("user-email").textContent = profile.email || profile.authEmail || "";
  document.getElementById("user-avatar").textContent = (profile.full_name || "A").charAt(0).toUpperCase();

  document.getElementById("collapse-btn").addEventListener("click", () => {
    shell.classList.toggle("collapsed");
    document.getElementById("collapse-btn").textContent = shell.classList.contains("collapsed") ? "»" : "«";
  });
  document.getElementById("mobile-menu-btn").addEventListener("click", () => shell.classList.toggle("mobile-open"));
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await DataLogsAPI.signOut();
    window.location.href = "../agent/auth.html";
  });

  document.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  });

  function showPanel(id) {
    document.querySelectorAll("[data-panel]").forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === id));
    document.querySelectorAll("[data-panel-view]").forEach((panel) =>
      panel.classList.toggle("active", panel.dataset.panelView === id)
    );
    const [title, sub] = titles[id];
    document.getElementById("panel-title").textContent = title;
    document.getElementById("panel-sub").textContent = sub;
    shell.classList.remove("mobile-open");
  }

  const form = document.getElementById("package-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("package-error");
    error.hidden = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const existing = await DataLogsAPI.fetchPackages({ includeInactive: true });
      const sameNetwork = existing.filter((p) => p.network === data.network && p.id !== data.id);
      const sortOrder = Math.round(Number(data.gb) * 10);
      await DataLogsAPI.upsertPackage({
        id: data.id || undefined,
        network: data.network,
        gb: data.gb,
        retail_price: data.retail_price,
        agent_price: data.agent_price,
        validity: "Non expiry",
        tag: null,
        sort_order: sortOrder || sameNetwork.length + 1,
        active: true,
      });
      form.reset();
      document.getElementById("package-id").value = "";
      await refreshAll();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || "Could not save package.";
    }
  });

  document.getElementById("package-reset").addEventListener("click", () => {
    form.reset();
    document.getElementById("package-id").value = "";
  });

  async function refreshAll() {
    const [users, packages, orders, stores] = await Promise.all([
      DataLogsAPI.allUsers(),
      DataLogsAPI.fetchPackages({ includeInactive: true }),
      DataLogsAPI.allOrders(),
      DataLogsAPI.allStores(),
    ]);

    document.getElementById("stat-users").textContent = String(users.length);
    document.getElementById("stat-packages").textContent = String(packages.length);
    document.getElementById("stat-orders").textContent = String(orders.length);
    const revenue = orders
      .filter((o) => o.payment_status === "paid")
      .reduce((sum, o) => sum + Number(o.amount_paid || 0), 0);
    document.getElementById("stat-revenue").textContent = formatCedi(revenue);

    document.getElementById("overview-orders").innerHTML = orders.length
      ? `<div class="table-wrap"><table class="orders-table"><thead><tr><th>Code</th><th>Source</th><th>Package</th><th>Paid</th><th>Delivery</th><th>Date</th><th>Time</th></tr></thead><tbody>${orders
          .slice(0, 8)
          .map((o) => {
            const when = formatOrderDateTime(o.created_at);
            return `<tr><td>${o.order_code}</td><td>${orderSourceLabel(o)}</td><td>${NETWORKS[o.network]?.name || o.network} ${o.gb}GB</td><td>${formatCedi(o.amount_paid)}</td><td>${o.delivery_status}</td><td>${when.date}</td><td>${when.time}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<div class="empty-state">No orders yet.</div>`;

    document.getElementById("packages-body").innerHTML = packages
      .map(
        (p) => `
      <tr>
        <td>${NETWORKS[p.network]?.name || p.network}</td>
        <td>${p.gb}</td>
        <td>${formatCedi(p.retail)}</td>
        <td>${formatCedi(p.agentPrice)}</td>
        <td>${p.validity || "Non expiry"}</td>
        <td>
          <button class="btn btn-ghost" type="button" data-edit-package='${JSON.stringify(p).replace(/'/g, "&#39;")}'>Edit</button>
          <button class="btn btn-ghost" type="button" data-delete-package="${p.id}">Delete</button>
        </td>
      </tr>`
      )
      .join("");

    document.getElementById("orders-body").innerHTML = orders
      .map((o) => {
        const buyer = o.profiles ? o.profiles.full_name || o.profiles.email : "Guest";
        const when = formatOrderDateTime(o.created_at);
        return `
        <tr>
          <td>${o.order_code}</td>
          <td>${orderSourceLabel(o)}</td>
          <td>${buyer}</td>
          <td>${NETWORKS[o.network]?.name || o.network} ${o.gb} GB</td>
          <td>${o.recipient_number}</td>
          <td>${formatCedi(o.amount_paid)}</td>
          <td>${o.payment_status}</td>
          <td>
            <select data-delivery="${o.id}">
              ${["pending", "processing", "delivered", "failed"]
                .map((s) => `<option value="${s}" ${o.delivery_status === s ? "selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </td>
          <td>${when.date}</td>
          <td>${when.time}</td>
        </tr>`;
      })
      .join("");

    document.getElementById("users-body").innerHTML = users
      .map(
        (u) => `
      <tr>
        <td>${u.full_name || "—"}</td>
        <td>${u.email || "—"}</td>
        <td>${u.phone || "—"}</td>
        <td>
          <select data-role="${u.id}" ${u.id === profile.id ? "disabled" : ""}>
            ${["customer", "agent", "admin"]
              .map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`)
              .join("")}
          </select>
        </td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
      </tr>`
      )
      .join("");

    document.getElementById("stores-body").innerHTML = stores
      .map((s) => {
        const agent = s.profiles ? s.profiles.full_name || s.profiles.email : "—";
        return `
        <tr>
          <td>${s.name}</td>
          <td><a href="../store.html?s=${encodeURIComponent(s.slug)}" target="_blank" rel="noopener">${s.slug}</a></td>
          <td>${agent}</td>
          <td>${s.published ? "Yes" : "No"}</td>
          <td>${new Date(s.updated_at).toLocaleString()}</td>
        </tr>`;
      })
      .join("");
  }

  document.getElementById("packages-body").addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-package]");
    if (editBtn) {
      const p = JSON.parse(editBtn.getAttribute("data-edit-package"));
      form.id.value = p.id;
      form.network.value = p.network;
      form.gb.value = p.gb;
      form.retail_price.value = p.retail;
      form.agent_price.value = p.agentPrice;
      showPanel("packages");
      return;
    }
    const delBtn = event.target.closest("[data-delete-package]");
    if (delBtn && confirm("Delete this package?")) {
      await DataLogsAPI.deletePackage(delBtn.dataset.deletePackage);
      await refreshAll();
    }
  });

  document.getElementById("orders-body").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-delivery]");
    if (!select) return;
    await DataLogsAPI.updateOrder(select.dataset.delivery, { delivery_status: select.value });
    await refreshAll();
  });

  document.getElementById("users-body").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-role]");
    if (!select) return;
    await DataLogsAPI.updateUserRole(select.dataset.role, select.value);
    await refreshAll();
  });

  await refreshAll();
})();
