(function customerLocal() {
  const BEN_KEY = "datalogs_beneficiaries";
  const RECENT_KEY = "datalogs_recent_orders";
  const MY_PHONE_KEY = "datalogs_my_phone";

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid() {
    return `ben_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    let local = digits;
    if (local.startsWith("233") && local.length === 12) local = `0${local.slice(3)}`;
    if (local.length === 9) local = `0${local}`;
    return local;
  }

  function getBeneficiaries(network) {
    const list = read(BEN_KEY, []);
    if (!network) return list;
    return list.filter((b) => !b.network || b.network === network);
  }

  function saveBeneficiary({ label, phone, network, isDefault }) {
    const list = getBeneficiaries();
    const entry = {
      id: uid(),
      label: String(label || "Saved number").trim(),
      phone: normalizePhone(phone),
      network: network || null,
      isDefault: !!isDefault,
      createdAt: new Date().toISOString(),
    };
    if (entry.isDefault) {
      list.forEach((b) => {
        if (b.network === entry.network) b.isDefault = false;
      });
    }
    list.unshift(entry);
    write(BEN_KEY, list.slice(0, 20));
    return entry;
  }

  function updateBeneficiary(id, patch) {
    const list = getBeneficiaries();
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch, phone: patch.phone ? normalizePhone(patch.phone) : list[idx].phone };
    if (patch.isDefault) {
      list.forEach((b, i) => {
        if (i !== idx && b.network === list[idx].network) b.isDefault = false;
      });
    }
    write(BEN_KEY, list);
    return list[idx];
  }

  function deleteBeneficiary(id) {
    write(
      BEN_KEY,
      getBeneficiaries().filter((b) => b.id !== id)
    );
  }

  function getMyPhone() {
    return localStorage.getItem(MY_PHONE_KEY) || "";
  }

  function setMyPhone(phone) {
    localStorage.setItem(MY_PHONE_KEY, normalizePhone(phone));
  }

  function getRecentOrders() {
    return read(RECENT_KEY, []);
  }

  function saveRecentOrder(order, pkg, meta) {
    if (!order?.order_code || !pkg?.id) return;
    const list = getRecentOrders().filter((item) => item.orderCode !== order.order_code);
    list.unshift({
      orderCode: order.order_code,
      packageId: pkg.id,
      network: pkg.network,
      gb: pkg.gb,
      price: Number(order.amount_paid ?? pkg.price),
      recipient: order.recipient_number || meta?.recipient || "",
      tier: meta?.tier || "retail",
      storeId: meta?.storeId || null,
      method: meta?.method || "",
      status: order.delivery_status || "",
      createdAt: order.created_at || new Date().toISOString(),
    });
    write(RECENT_KEY, list.slice(0, 12));
  }

  function buyAgain(detail) {
    document.dispatchEvent(
      new CustomEvent("datalogs:buy-again", {
        detail: {
          packageId: detail.packageId,
          recipient: detail.recipient || "",
          tier: detail.tier || "retail",
          storeId: detail.storeId || null,
        },
      })
    );
  }

  window.DataLogsCustomer = {
    getBeneficiaries,
    saveBeneficiary,
    updateBeneficiary,
    deleteBeneficiary,
    getMyPhone,
    setMyPhone,
    getRecentOrders,
    saveRecentOrder,
    buyAgain,
    normalizePhone,
  };
})();
