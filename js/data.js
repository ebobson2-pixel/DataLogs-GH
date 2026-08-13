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
  return `GH₵ ${Number(amount).toFixed(2)}`;
}

function mapPackage(row) {
  return {
    id: row.id,
    network: row.network,
    gb: Number(row.gb),
    price: Number(row.retail_price),
    retail: Number(row.retail_price),
    agentPrice: Number(row.agent_price),
    validity: row.validity,
    tag: row.tag || null,
    active: row.active,
    sort_order: row.sort_order,
  };
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

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}
