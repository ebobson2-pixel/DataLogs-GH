window.DataLogsFlyer = (() => {
  const W = 1080;
  const H = 1350;
  const MODELS = {
    hub: "../assets/flyers/model-hub.png",
    plug: "../assets/flyers/model-plug.png",
    package: "../assets/flyers/model-package.png",
  };
  const COLORS = {
    mtn: "#ffcc00",
    at: "#003087",
    telecel: "#e30613",
    cream: "#eef4ea",
    ink: "#111111",
  };

  const imageCache = new Map();
  const cutoutCache = new Map();

  function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const pending = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load flyer artwork."));
      img.src = src;
    });
    imageCache.set(src, pending);
    return pending;
  }

  async function cutout(src) {
    if (cutoutCache.has(src)) return cutoutCache.get(src);
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 248 && px[i + 1] > 248 && px[i + 2] > 248) px[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    cutoutCache.set(src, canvas);
    return canvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function fillRound(ctx, x, y, w, h, r, color) {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
  }

  function fitText(ctx, text, maxWidth, fontFn) {
    let size = fontFn(1);
    ctx.font = fontFn(size);
    while (size > 18 && ctx.measureText(text).width > maxWidth) {
      size -= 2;
      ctx.font = fontFn(size);
    }
    return size;
  }

  function gbLabel(gb) {
    const n = Number(gb);
    return Number.isInteger(n) ? `${n}GB` : `${n}GB`;
  }

  function priceLabel(amount, kind) {
    const n = Number(amount);
    if (!Number.isFinite(n)) {
      return typeof formatCedi === "function" ? formatCedi(0) : "GH\u20B5 0.00";
    }
    if (kind === "cent") {
      const num = Number.isInteger(n) ? String(n) : n.toFixed(2);
      return `\u00A2${num}`;
    }
    if (typeof formatCedi === "function") return formatCedi(n);
    const num = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return `GH\u20B5 ${num}`;
  }

  function byNetwork(packages) {
    return {
      mtn: (packages || []).filter((p) => p.network === "mtn").sort((a, b) => a.gb - b.gb).slice(0, 16),
      airteltigo: (packages || []).filter((p) => p.network === "airteltigo").sort((a, b) => a.gb - b.gb).slice(0, 16),
      telecel: (packages || []).filter((p) => p.network === "telecel").sort((a, b) => a.gb - b.gb).slice(0, 16),
    };
  }

  function drawMtnLogo(ctx, cx, cy, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.mtn;
    ctx.fill();
    ctx.lineWidth = Math.max(3, r * 0.06);
    ctx.strokeStyle = "#1a1a1a";
    ctx.stroke();
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `800 ${r * 0.42}px Montserrat, Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("MTN", cx, cy);
    ctx.restore();
  }

  function drawAtLogo(ctx, cx, cy, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.fillStyle = COLORS.at;
    ctx.font = `800 ${r * 0.62}px Montserrat, Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("at", cx, cy + r * 0.04);
    ctx.restore();
  }

  function drawTelecelLogo(ctx, cx, cy, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.fillStyle = COLORS.telecel;
    ctx.font = `800 ${r * 0.78}px Montserrat, Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("t", cx, cy);
    ctx.restore();
  }

  function drawPriceLines(ctx, list, x, y, w, h, color, kind) {
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (!list.length) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.font = "800 26px Outfit, sans-serif";
      ctx.fillText("Set store prices", x + 18, y + 40);
      ctx.restore();
      return;
    }
    const rows = list.slice(0, 14);
    const row = Math.min(56, h / rows.length);
    const size = Math.max(24, Math.min(34, row * 0.62));
    rows.forEach((pkg, i) => {
      const cy = y + row * i + row / 2;
      if (i % 2 === 0) {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fillRect(x + 6, y + row * i + 2, w - 12, row - 4);
        ctx.globalAlpha = 1;
      }
      const left = gbLabel(pkg.gb);
      const right = priceLabel(pkg.price, kind === "cent" ? "ghc" : kind);
      ctx.fillStyle = color;
      ctx.font = `800 ${size}px Montserrat, Outfit, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(left, x + 18, cy);
      ctx.font = `900 ${size + 2}px Montserrat, Outfit, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText(right, x + w - 18, cy);
    });
    ctx.restore();
  }

  function networkLabel(key) {
    if (key === "mtn") return "MTN";
    if (key === "airteltigo") return "AirtelTigo";
    if (key === "telecel") return "Telecel";
    return String(key || "");
  }

  function siteInfoLine(data) {
    const tag = String(data?.tagline || "Affordable. Instant. Reliable.").slice(0, 38);
    return `${tag} · MoMo · MTN · AirtelTigo · Telecel · 1–5 min`;
  }

  function drawSiteInfoBar(ctx, y, data, bg) {
    const pad = 36;
    fillRound(ctx, pad, y, W - pad * 2, 44, 12, bg || "#1a1a1a");
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = "700 18px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const line = siteInfoLine(data);
    fitText(ctx, line, W - pad * 2 - 24, (s) => `700 ${s}px Outfit, sans-serif`);
    ctx.fillText(line, W / 2, y + 22);
  }

  function drawCaption(ctx, dataOrUrl) {
    const data = typeof dataOrUrl === "object" && dataOrUrl !== null ? dataOrUrl : { url: dataOrUrl };
    const pad = 36;
    drawSiteInfoBar(ctx, H - 122, data, "#1a1a1a");
    fillRound(ctx, pad, H - 68, W - pad * 2, 48, 16, "#111");
    ctx.fillStyle = "#fff";
    ctx.font = "800 24px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = String(data.url || "").replace(/^https?:\/\//, "");
    fitText(ctx, label, W - 120, (s) => `800 ${s}px Outfit, sans-serif`);
    ctx.fillText(label, W / 2, H - 44);
  }

  function doodleHub(ctx) {
    ctx.save();
    ctx.strokeStyle = "rgba(40, 90, 40, 0.12)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 18; i += 1) {
      ctx.beginPath();
      ctx.arc(80 + (i * 137) % W, 90 + (i * 83) % 500, 18 + (i % 5) * 8, 0, Math.PI * 1.4);
      ctx.stroke();
    }
    ctx.restore();
  }

  async function drawHub(ctx, data) {
    ctx.fillStyle = COLORS.cream;
    ctx.fillRect(0, 0, W, H);
    doodleHub(ctx);

    ctx.fillStyle = COLORS.telecel;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const title = String(data.name || "Data Hub").toUpperCase();
    fitText(ctx, title, 980, (s) => `800 ${s}px Fredoka, Outfit, sans-serif`);
    ctx.fillText(title, W / 2, 92);

    fillRound(ctx, 250, 112, 580, 58, 10, COLORS.mtn);
    ctx.strokeStyle = COLORS.telecel;
    ctx.lineWidth = 4;
    roundRect(ctx, 250, 112, 580, 58, 10);
    ctx.stroke();
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "800 28px Montserrat, Outfit, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("DATA BUNDLE HUB", W / 2, 141);

    const groups = byNetwork(data.packages);
    const cols = [
      { x: 40, y: 190, w: 320, h: 780, bg: COLORS.mtn, color: "#111", list: groups.mtn, logo: drawMtnLogo, kind: "ghc" },
      { x: 380, y: 190, w: 320, h: 780, bg: COLORS.at, color: "#fff", list: groups.airteltigo, logo: drawAtLogo, kind: "ghc" },
      { x: 720, y: 190, w: 320, h: 780, bg: COLORS.telecel, color: "#fff", list: groups.telecel, logo: drawTelecelLogo, kind: "ghc" },
    ];
    cols.forEach((col) => {
      fillRound(ctx, col.x, col.y, col.w, col.h, 48, col.bg);
      col.logo(ctx, col.x + col.w / 2, col.y + 70, 48);
      drawPriceLines(ctx, col.list, col.x + 4, col.y + 140, col.w - 8, col.h - 170, col.color, col.kind);
    });

    fillRound(ctx, 40, 1000, W - 80, 170, 24, COLORS.telecel);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.font = "800 28px Montserrat, Outfit, sans-serif";
    ctx.fillText("Buy Affordable Data", 64, 1048);
    ctx.fillStyle = COLORS.mtn;
    ctx.font = "900 40px Montserrat, Outfit, sans-serif";
    ctx.fillText(data.phone || "Add your number", 64, 1100);
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px Montserrat, Outfit, sans-serif";
    ctx.fillText("WhatsApp / Call · Delivery in minutes", 64, 1140);

    drawCaption(ctx, data);
  }

  function wrapLines(ctx, text, x, y, width, lineHeight) {
    const words = String(text).split(" ");
    let line = "";
    let cy = y;
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > width - 24 && line) {
        ctx.fillText(line, x + width / 2, cy);
        line = word;
        cy += lineHeight;
      } else {
        line = test;
      }
    });
    if (line) ctx.fillText(line, x + width / 2, cy);
  }

  function drawGridColumn(ctx, x, y, w, h, headerColor, bodyColor, textColor, list, logoFn, lineColor, splitAt, splitColor) {
    fillRound(ctx, x, y, w, 92, 18, headerColor);
    ctx.beginPath();
    ctx.rect(x, y + 46, w, h - 46);
    ctx.fillStyle = bodyColor;
    ctx.fill();
    fillRound(ctx, x, y + h - 24, w, 24, 18, splitAt != null ? splitColor || bodyColor : bodyColor);
    logoFn(ctx, x + w / 2, y + 46, 36);
    const rows = list.length ? list.slice(0, 12) : [];
    const top = y + 102;
    const rowH = rows.length ? Math.min(58, (h - 120) / Math.max(rows.length, 1)) : 40;
    const fontSize = Math.max(24, Math.min(32, rowH * 0.55));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.font = `800 ${fontSize}px Montserrat, Outfit, sans-serif`;
    ctx.textBaseline = "middle";
    if (!rows.length) {
      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      ctx.fillText("Set prices", x + w / 2, top + 40);
      return;
    }
    rows.forEach((pkg, i) => {
      const ry = top + i * rowH;
      if (splitAt != null && i >= splitAt) {
        ctx.fillStyle = splitColor;
        ctx.fillRect(x, ry, w, rowH + 1);
      }
      ctx.beginPath();
      ctx.moveTo(x, ry);
      ctx.lineTo(x + w, ry);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.42, ry);
      ctx.lineTo(x + w * 0.42, ry + rowH);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      ctx.fillText(gbLabel(pkg.gb), x + w * 0.21, ry + rowH / 2);
      ctx.font = `900 ${fontSize + 2}px Montserrat, Outfit, sans-serif`;
      ctx.fillText(priceLabel(pkg.price, "ghc"), x + w * 0.71, ry + rowH / 2);
      ctx.font = `800 ${fontSize}px Montserrat, Outfit, sans-serif`;
    });
  }

  async function drawPlug(ctx, data) {
    const sky = ctx.createLinearGradient(0, 0, 0, 520);
    sky.addColorStop(0, "#5aaee0");
    sky.addColorStop(1, "#d7eef8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, 520);
    ctx.fillStyle = "#3c9a3a";
    ctx.fillRect(0, 500, W, 180);
    ctx.fillStyle = "#f7f7f4";
    ctx.fillRect(0, 640, W, H - 640);

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.ellipse(180, 140, 70, 36, 0, 0, Math.PI * 2);
    ctx.ellipse(240, 150, 90, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(860, 110, 80, 34, 0, 0, Math.PI * 2);
    ctx.fill();

    const icons = ["#29a9e1", "#111", "#e1306c", "#69c9d0", "#f5c518"];
    icons.forEach((color, i) => {
      ctx.beginPath();
      ctx.arc(70 + i * 18, 430 + (i % 2) * 40, 16, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(980 - i * 22, 390 + (i % 3) * 28, 14, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    fitText(ctx, data.name || "Data Hub", 980, (s) => `900 ${s}px Montserrat, Outfit, sans-serif`);
    ctx.fillText(data.name || "Data Hub", W / 2, 86);
    ctx.font = "600 28px Montserrat, Outfit, sans-serif";
    ctx.fillText(`-${data.tagline || "Your Trusted Data Plug"}-`, W / 2, 128);

    const groups = byNetwork(data.packages);
    drawGridColumn(
      ctx, 40, 160, 320, 780, COLORS.at, COLORS.at, "#fff",
      groups.airteltigo, drawAtLogo, "rgba(255,255,255,0.55)", 4, COLORS.telecel
    );
    drawGridColumn(ctx, 380, 160, 320, 780, COLORS.mtn, COLORS.mtn, "#111", groups.mtn, drawMtnLogo, "rgba(0,0,0,0.35)");
    drawGridColumn(ctx, 720, 160, 320, 780, COLORS.telecel, COLORS.telecel, "#fff", groups.telecel, drawTelecelLogo, "rgba(255,255,255,0.45)");

    fillRound(ctx, 40, 970, W - 80, 160, 24, "#fff");
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.ink;
    ctx.font = "800 28px Montserrat, Outfit, sans-serif";
    ctx.fillText("Buy Affordable Data Package", 64, 1020);
    ctx.font = "800 24px Montserrat, Outfit, sans-serif";
    ctx.fillText("DM or CALL", 64, 1060);
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "900 40px Montserrat, Outfit, sans-serif";
    ctx.fillText(data.phone || "Add your number", 64, 1108);

    drawCaption(ctx, data);
  }

  async function drawPackage(ctx, data) {
    const bg = ctx.createRadialGradient(W * 0.7, H * 0.2, 40, W * 0.4, H * 0.5, 900);
    bg.addColorStop(0, "#1c5c43");
    bg.addColorStop(1, "#0b2f22");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.arc(990, 200, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "800 36px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("♥", 990, 212);

    const name = data.name || "Agent";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    ctx.font = "800 52px Montserrat, Outfit, sans-serif";
    ctx.fillText(name, 48, 86);
    ctx.fillStyle = COLORS.mtn;
    ctx.font = "800 52px Montserrat, Outfit, sans-serif";
    ctx.fillText("Data", 48, 148);
    ctx.fillStyle = "#fff";
    ctx.fillText("Package", 48, 210);

    fillRound(ctx, 620, 48, 420, 56, 28, "#2f7a58");
    ctx.fillStyle = "#fff";
    ctx.font = "700 20px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`Working hours: ${data.hours || "8am - 9pm Each day"}`, 830, 76);

    const groups = byNetwork(data.packages);
    const cards = [
      { x: 40, y: 230, w: 320, border: COLORS.mtn, list: groups.mtn, logo: drawMtnLogo },
      { x: 380, y: 230, w: 320, border: "#cfd8e3", list: groups.airteltigo, logo: drawAtLogo },
      { x: 720, y: 230, w: 320, border: COLORS.telecel, list: groups.telecel, logo: drawTelecelLogo },
    ];
    cards.forEach((card) => {
      ctx.save();
      ctx.shadowColor = card.border;
      ctx.shadowBlur = 14;
      fillRound(ctx, card.x, card.y, card.w, 720, 28, "#123d2d");
      ctx.restore();
      ctx.lineWidth = 5;
      ctx.strokeStyle = card.border;
      roundRect(ctx, card.x, card.y, card.w, 720, 28);
      ctx.stroke();
      card.logo(ctx, card.x + card.w / 2, card.y + 58, 42);
      drawPriceLines(ctx, card.list, card.x + 6, card.y + 120, card.w - 12, 560, "#fff", "ghc");
    });

    fillRound(ctx, 40, 980, W - 80, 140, 28, "#fff");
    ctx.fillStyle = "#123d2d";
    ctx.font = "700 22px Outfit, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("To purchase contact", 70, 1020);
    ctx.font = "900 40px Montserrat, Outfit, sans-serif";
    ctx.fillText(`☎  ${data.phoneIntl || data.phone || "Add your number"}`, 70, 1075);

    drawCaption(ctx, data);
  }

  function hexToRgb(hex) {
    const raw = String(hex || "").replace("#", "").trim();
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return { r: 46, g: 200, b: 230 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function contrastInk(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? "#0b0b0b" : "#ffffff";
  }

  function rgba(hex, a) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  function strokeRound(ctx, x, y, w, h, r, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 2;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
  }

  function drawBolt(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.56, y + s * 0.12);
    ctx.lineTo(x + s * 0.3, y + s * 0.54);
    ctx.lineTo(x + s * 0.5, y + s * 0.54);
    ctx.lineTo(x + s * 0.4, y + s * 0.88);
    ctx.lineTo(x + s * 0.74, y + s * 0.42);
    ctx.lineTo(x + s * 0.52, y + s * 0.42);
    ctx.closePath();
    ctx.fill();
  }

  const SHOP_NETS = [
    {
      key: "mtn",
      name: "MTN",
      title: "MTN DATA BUNDLES",
      tab: "MTN",
      color: "#ffcc00",
      btn: "#ffcc00",
      btnInk: "#111111",
      ink: "#ffcc00",
    },
    {
      key: "airteltigo",
      name: "AIRTELTIGO",
      title: "AIRTELTIGO DATA BUNDLES",
      tab: "AIRTELTIGO",
      color: "#3b82f6",
      btn: "#2563eb",
      btnInk: "#ffffff",
      ink: "#60a5fa",
    },
    {
      key: "telecel",
      name: "TELECEL",
      title: "TELECEL DATA BUNDLES",
      tab: "TELECEL",
      color: "#e11d2e",
      btn: "#e11d2e",
      btnInk: "#ffffff",
      ink: "#fb7185",
    },
  ];

  function shopHeight() {
    return H;
  }

  async function drawShop(ctx, data, canvas) {
    const accent = data.accent || "#2ec8e6";
    const onAccent = contrastInk(accent);
    const groups = byNetwork(data.packages);
    SHOP_NETS.forEach((net) => {
      groups[net.key] = (groups[net.key] || []).slice(0, 12);
    });
    canvas.height = H;
    canvas.width = W;

    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.72, 40, 20, W * 0.55, 120, 640);
    glow.addColorStop(0, rgba(accent, 0.28));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, 420);

    const pad = 36;
    fillRound(ctx, pad, 28, 58, 58, 14, accent);
    drawBolt(ctx, pad + 2, 30, 54, onAccent);

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "800 36px Montserrat, Outfit, sans-serif";
    const storeName = String(data.name || "DATA HUB").toUpperCase();
    ctx.fillText(storeName, pad + 74, 48);
    ctx.fillStyle = accent;
    ctx.font = "700 18px Outfit, sans-serif";
    ctx.fillText((data.tagline || "Affordable. Instant. Reliable.").slice(0, 42), pad + 74, 78);

    fillRound(ctx, W - pad - 210, 32, 210, 50, 24, accent);
    ctx.fillStyle = onAccent;
    ctx.font = "800 18px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Visit store →", W - pad - 105, 57);

    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = "900 40px Montserrat, Outfit, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("CLEAR PRICES — ALL NETWORKS", pad, 150);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "700 20px Outfit, sans-serif";
    ctx.fillText("MTN · AirtelTigo · Telecel  ·  MoMo  ·  Fast delivery", pad, 182);

    const chips = [
      { label: "WHATSAPP / CALL", value: data.phone || "Add your number", bg: "#0f1720", color: "#fff" },
      { label: "WORKING HOURS", value: data.hours || "8am - 9pm Each day", bg: "#0f1720", color: "#fff" },
      { label: "CHAT ON WHATSAPP", value: "Chat now", bg: "#25d366", color: "#06240f" },
    ];
    const chipW = (W - pad * 2 - 20) / 3;
    chips.forEach((chip, i) => {
      const x = pad + i * (chipW + 10);
      fillRound(ctx, x, 206, chipW, 84, 16, chip.bg);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "800 14px Outfit, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(chip.label, x + 16, 234);
      ctx.fillStyle = chip.color;
      ctx.font = "900 24px Outfit, sans-serif";
      fitText(ctx, chip.value, chipW - 32, (s) => `900 ${s}px Outfit, sans-serif`);
      ctx.fillText(chip.value, x + 16, 268);
    });

    const nets = [
      { key: "mtn", title: "MTN", bg: COLORS.mtn, ink: "#111", logo: drawMtnLogo },
      { key: "airteltigo", title: "AIRTELTIGO", bg: COLORS.at, ink: "#fff", logo: drawAtLogo },
      { key: "telecel", title: "TELECEL", bg: COLORS.telecel, ink: "#fff", logo: drawTelecelLogo },
    ];
    const colW = (W - pad * 2 - 24) / 3;
    const colY = 316;
    const colH = 860;

    nets.forEach((net, i) => {
      const x = pad + i * (colW + 12);
      const list = groups[net.key] || [];
      fillRound(ctx, x, colY, colW, colH, 28, "#0d1118");
      strokeRound(ctx, x, colY, colW, colH, 28, net.bg, 4);
      fillRound(ctx, x + 14, colY + 14, colW - 28, 72, 18, net.bg);
      net.logo(ctx, x + 52, colY + 50, 28);
      ctx.fillStyle = net.ink;
      ctx.font = "900 22px Montserrat, Outfit, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(net.title, x + 92, colY + 50);

      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "800 16px Outfit, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("DATA", x + 22, colY + 118);
      ctx.textAlign = "right";
      ctx.fillText("PRICE", x + colW - 22, colY + 118);

      drawPriceLines(ctx, list, x + 4, colY + 138, colW - 8, colH - 168, "#ffffff", "ghc");
    });

    if (!nets.some((n) => (groups[n.key] || []).length)) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "800 28px Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Set store prices to fill this flyer.", W / 2, 700);
    }

    drawSiteInfoBar(ctx, H - 122, data, "#0d1118");
    fillRound(ctx, pad, H - 68, W - pad * 2, 48, 16, accent);
    ctx.fillStyle = onAccent;
    ctx.font = "800 22px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = String(data.url || "").replace(/^https?:\/\//, "");
    fitText(ctx, label, W - pad * 2 - 40, (s) => `800 ${s}px Outfit, sans-serif`);
    ctx.fillText(label, W / 2, H - 44);
  }

  function buildShareMessage(data) {
    const name = data?.name || "Data Store";
    const tagline = data?.tagline || "Affordable. Instant. Reliable.";
    const url = data?.url || "";
    const phone = data?.phone || "";
    const hours = data?.hours || "8am - 9pm Each day";
    const groups = byNetwork(data?.packages || []);
    const sampleLines = [];
    ["mtn", "airteltigo", "telecel"].forEach((net) => {
      (groups[net] || []).slice(0, 3).forEach((pkg) => {
        sampleLines.push(`${networkLabel(net)} ${gbLabel(pkg.gb)} — ${priceLabel(pkg.price, "ghc")}`);
      });
    });
    const lines = [
      `📱 ${name}`,
      tagline,
      "",
      "Buy affordable data bundles for MTN, AirtelTigo & Telecel in Ghana.",
      "💳 Pay with Mobile Money · ⚡ Delivered in 1–5 minutes",
      "",
      `🛒 Order online: ${url}`,
    ];
    if (phone) lines.push(`📞 WhatsApp / Call: ${phone}`);
    lines.push(`🕐 Working hours: ${hours}`);
    if (sampleLines.length) {
      lines.push("", "Sample prices:", ...sampleLines.slice(0, 9));
    }
    lines.push("", "Full price list is on the flyer image. Tap the link to buy instantly!");
    return lines.join("\n");
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare flyer image."))), "image/jpeg", 0.92);
    });
  }

  function blobToPng(blob) {
    return new Promise(async (resolve, reject) => {
      try {
        const bitmap = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d").drawImage(bitmap, 0, 0);
        c.toBlob((png) => (png ? resolve(png) : reject(new Error("Could not convert flyer image."))), "image/png");
      } catch (err) {
        reject(err);
      }
    });
  }

  function whatsappShareUrl(text) {
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  }

  async function copyShareMessage(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Nothing to copy.");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  function canSharePayload(payload) {
    if (!navigator.share) return false;
    if (!navigator.canShare) return true;
    try {
      return navigator.canShare(payload);
    } catch {
      return false;
    }
  }

  async function tryNativeShareBoth(file, text) {
    if (!navigator.share) return false;
    const both = { files: [file], text, title: "DataLogs flyer" };
    const filesOnly = { files: [file], title: "DataLogs flyer" };

    if (canSharePayload(both)) {
      await navigator.share(both);
      return "shared";
    }

    if (canSharePayload(filesOnly)) {
      try {
        await navigator.share(both);
        return "shared";
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        await copyShareMessage(text);
        await navigator.share(filesOnly);
        return "shared-file-text-copied";
      }
    }

    return false;
  }

  async function copyImageAndText(blob, text) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    const plain = new Blob([text], { type: "text/plain" });
    const attempts = [];

    try {
      const png = await blobToPng(blob);
      attempts.push({ "image/png": png, "text/plain": plain });
      attempts.push({ "image/png": png });
    } catch {
      /* jpeg fallback below */
    }
    attempts.push({ "image/jpeg": blob, "text/plain": plain });
    attempts.push({ "image/jpeg": blob });

    for (const types of attempts) {
      try {
        await navigator.clipboard.write([new ClipboardItem(types)]);
        const hasImage = Object.keys(types).some((k) => k.startsWith("image/"));
        const hasText = "text/plain" in types;
        if (hasImage && hasText) return "both";
        if (hasImage) return "image";
      } catch {
        /* try next mime combo */
      }
    }
    return false;
  }

  async function shareWithMessage(canvas, message, filename, { openWhatsApp = false } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Share message is empty.");
    const blob = await canvasToBlob(canvas);
    const name = filename || "store-flyer.jpg";
    const file = new File([blob], name, { type: "image/jpeg" });

    // Never share text-only — always include the flyer image when possible.
    try {
      const mode = await tryNativeShareBoth(file, text);
      if (mode) return mode;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }

    const copied = await copyImageAndText(blob, text);
    if (copied) {
      if (openWhatsApp) {
        window.open(whatsappShareUrl(text), "_blank", "noopener,noreferrer");
        return "clipboard-whatsapp";
      }
      return "clipboard";
    }

    await copyShareMessage(text);
    await download(canvas, name);
    if (openWhatsApp) {
      window.open(whatsappShareUrl(text), "_blank", "noopener,noreferrer");
      return "copy-download-whatsapp";
    }
    return "copy-download";
  }

  async function share(canvas, data, filename, message) {
    const text = message ?? buildShareMessage(data);
    return shareWithMessage(canvas, text, filename, { openWhatsApp: false });
  }

  async function shareWhatsApp(canvas, message, filename) {
    return shareWithMessage(canvas, message, filename, { openWhatsApp: true });
  }

  async function render(canvas, style, data) {
    const ctx = canvas.getContext("2d");
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    if (document.fonts?.ready) await document.fonts.ready;
    if (style === "plug") await drawPlug(ctx, data);
    else if (style === "package") await drawPackage(ctx, data);
    else if (style === "hub") await drawHub(ctx, data);
    else await drawShop(ctx, data, canvas);
    return canvas;
  }

  function download(canvas, filename) {
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename || "store-flyer.jpg";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1500);
          resolve();
        },
        "image/jpeg",
        0.92
      );
    });
  }

  return {
    render,
    download,
    buildShareMessage,
    whatsappShareUrl,
    copyShareMessage,
    share,
    shareWhatsApp,
    shareWithMessage,
    templates: ["shop", "hub", "plug", "package"],
  };
})();
