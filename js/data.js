const NETWORKS = {
  mtn: {
    id: "mtn",
    name: "MTN",
    blurb: "Ghana’s most used network — fast, familiar, everywhere.",
    prefixes: ["024", "025", "053", "054", "055", "059"],
  },
  airteltigo: {
    id: "airteltigo",
    name: "AirtelTigo",
    blurb: "Sharp AT bundles for calls, socials and everyday browsing.",
    prefixes: ["026", "027", "056", "057"],
  },
  telecel: {
    id: "telecel",
    name: "Telecel",
    blurb: "Reliable Telecel data for home, work and the road.",
    prefixes: ["020", "050"],
  },
};

function formatCedi(amount) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return "GH\u20B5 " + safe.toFixed(2);
}

function mapPackage(row) {
  if (row && row.id && Number.isFinite(Number(row.retail ?? row.price)) && Number.isFinite(Number(row.agentPrice))) {
    return row;
  }
  const agentPrice = Number(row.agent_price);
  return {
    id: row.id,
    network: row.network,
    gb: Number(row.gb),
    price: Number(row.retail_price),
    retail: Number(row.retail_price),
    agentPrice,
    defaultAgentPrice: agentPrice,
    customPriced: false,
    validity: row.validity,
    tag: row.tag || null,
    active: row.active,
    sort_order: row.sort_order,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function supportContactMeta(settings) {
  const contact = String(settings?.support_contact || "").trim();
  const label = String(settings?.support_label || "Support").trim() || "Support";
  if (!contact) return null;
  const digits = contact.replace(/\D/g, "");
  const meta = { label, contact, href: null, wa: null, tel: null };
  if (contact.includes("@")) {
    meta.href = `mailto:${contact}`;
  } else if (digits.length >= 9) {
    let wa = digits;
    if (wa.startsWith("0") && wa.length === 10) wa = `233${wa.slice(1)}`;
    meta.tel = `tel:${digits}`;
    meta.wa = `https://wa.me/${wa}`;
    meta.href = meta.tel;
  }
  return meta;
}

function packagesFor(network, list) {
  const source = list || window.__PACKAGES || [];
  if (!network || network === "all") return source;
  return source.filter((item) => item.network === network);
}

function getPackage(id, list) {
  const source = list || window.__PACKAGES || [];
  return source.find((item) => item.id === id);
}

function roundCedi(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

function defaultStoreProfit(pkg) {
  const retail = Number(pkg.retail ?? pkg.price);
  const base = Number(pkg.agentPrice);
  if (!Number.isFinite(retail) || !Number.isFinite(base)) return 0;
  return Math.max(0, roundCedi(retail - base));
}

function resolveStorePackagePrice(pkg, profitByPackage) {
  const map = profitByPackage instanceof Map ? profitByPackage : new Map();
  const base = Number(pkg.agentPrice);
  const retail = Number(pkg.retail ?? pkg.price);
  const custom = map.has(pkg.id);
  if (!Number.isFinite(base)) {
    const fallback = Number.isFinite(retail) ? roundCedi(retail) : 0;
    return { profit: 0, price: fallback, custom: false };
  }
  const profit = custom ? Number(map.get(pkg.id)) : defaultStoreProfit(pkg);
  const safeProfit = Number.isFinite(profit) ? profit : 0;
  return {
    profit: safeProfit,
    price: roundCedi(base + safeProfit),
    custom,
  };
}

function validateGhanaNumber(value, network) {
  const digits = value.replace(/\D/g, "");
  let local = digits;
  if (local.startsWith("233") && local.length === 12) local = `0${local.slice(3)}`;
  if (local.length === 9) local = `0${local}`;
  if (!/^0\d{9}$/.test(local)) {
    return { ok: false, message: "Enter a valid Ghana number, like 024 123 4567." };
  }
  const prefix = local.slice(0, 3);
  const match = Object.values(NETWORKS).find((net) => net.prefixes.includes(prefix));
  if (!match) {
    return { ok: false, message: "That prefix is not recognised for MTN, AirtelTigo or Telecel." };
  }
  if (match.id !== network) {
    return {
      ok: false,
      message: `That looks like a ${match.name} number. Choose a ${match.name} package, or enter a ${NETWORKS[network].name} number.`,
    };
  }
  return { ok: true, pretty: `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` };
}

function orderSourceLabel(order) {
  if (order.agent_store_id) {
    const name = order.agent_stores?.name;
    return name ? `Agent store · ${name}` : "Agent store";
  }
  if (order.pricing_tier === "agent") return "Agent wholesale";
  return "Main website";
}

function formatOrderDateTime(iso) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    full: d.toLocaleString(),
  };
}

function publicDeliveryStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "delivered" || s === "completed") return "completed";
  if (s === "failed") return "failed";
  return "processing";
}

function publicDeliveryLabel(status) {
  const s = publicDeliveryStatus(status);
  if (s === "completed") return "Delivered";
  if (s === "failed") return "Failed";
  return "Processing";
}

window.publicDeliveryStatus = publicDeliveryStatus;
window.publicDeliveryLabel = publicDeliveryLabel;

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}
