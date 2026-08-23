window.DataLogsFlyer = (() => {
  const W = 1080;
  const H = 1440;
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
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (!list.length) {
      ctx.globalAlpha = 0.85;
      ctx.font = "700 22px Outfit, sans-serif";
      ctx.fillText("Set store prices", x + 16, y + 36);
      ctx.restore();
      return;
    }
    const row = Math.min(42, h / list.length);
    const size = Math.max(16, Math.min(26, row * 0.58));
    ctx.font = `700 ${size}px Montserrat, Outfit, sans-serif`;
    list.forEach((pkg, i) => {
      const cy = y + row * i + row / 2;
      const left = `${Number(pkg.gb) % 1 === 0 ? pkg.gb : pkg.gb} GB`;
      const right = priceLabel(pkg.price, kind);
      ctx.textAlign = "left";
      ctx.fillText(left, x + 14, cy);
      ctx.textAlign = "right";
      ctx.fillText(right, x + w - 14, cy);
    });
    ctx.restore();
  }

  function drawCaption(ctx, url) {
    fillRound(ctx, 36, H - 78, W - 72, 48, 16, "#111");
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = String(url || "").replace(/^https?:\/\//, "");
    fitText(ctx, label, W - 120, (s) => `700 ${s}px Outfit, sans-serif`);
    ctx.fillText(label, W / 2, H - 54);
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
      { x: 48, y: 200, w: 312, h: 720, bg: COLORS.mtn, color: "#111", list: groups.mtn, logo: drawMtnLogo, kind: "ghc" },
      { x: 384, y: 188, w: 312, h: 760, bg: COLORS.at, color: "#fff", list: groups.airteltigo, logo: drawAtLogo, kind: "ghc" },
      { x: 720, y: 200, w: 312, h: 560, bg: COLORS.telecel, color: "#fff", list: groups.telecel, logo: drawTelecelLogo, kind: "ghc" },
    ];
    cols.forEach((col) => {
      fillRound(ctx, col.x, col.y, col.w, col.h, 90, col.bg);
      col.logo(ctx, col.x + col.w / 2, col.y + 78, 52);
      drawPriceLines(ctx, col.list, col.x + 8, col.y + 150, col.w - 16, col.h - 180, col.color, col.kind);
    });

    const model = await cutout(MODELS.hub);
    ctx.drawImage(model, 430, 640, 680, 780);

    fillRound(ctx, 0, 930, 560, 390, 0, COLORS.telecel);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.font = "800 34px Montserrat, Outfit, sans-serif";
    ctx.fillText("Buy Affordable", 36, 990);
    ctx.fillStyle = COLORS.mtn;
    ctx.font = "900 72px Montserrat, Outfit, sans-serif";
    ctx.fillText("Data", 36, 1068);
    ctx.fillStyle = "#fff";
    ctx.font = "800 34px Montserrat, Outfit, sans-serif";
    ctx.fillText("Package", 36, 1118);
    ctx.font = "700 22px Montserrat, Outfit, sans-serif";
    ctx.fillText("WHATSAPP OR CALL", 36, 1170);
    ctx.fillStyle = COLORS.mtn;
    ctx.font = "900 52px Montserrat, Outfit, sans-serif";
    ctx.fillText(data.phone || "Add your number", 36, 1238);
    ctx.fillStyle = COLORS.mtn;
    ctx.fillRect(0, 1270, 560, 48);
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "800 24px Montserrat, Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Delivery Within Few Minutes", 280, 1296);

    fillRound(ctx, 790, 820, 230, 150, 28, COLORS.mtn);
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "800 28px Montserrat, Outfit, sans-serif";
    ctx.textAlign = "center";
    wrapLines(ctx, "BUY YOUR DATA HERE", 790, 870, 230, 32);

    drawCaption(ctx, data.url);
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
    const rows = list.length ? list : [];
    const top = y + 102;
    const rowH = rows.length ? Math.min(48, (h - 120) / Math.max(rows.length, 1)) : 40;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.font = "800 22px Montserrat, Outfit, sans-serif";
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
      ctx.moveTo(x + w * 0.46, ry);
      ctx.lineTo(x + w * 0.46, ry + rowH);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      ctx.fillText(gbLabel(pkg.gb), x + w * 0.23, ry + rowH / 2);
      ctx.fillText(priceLabel(pkg.price, "cent"), x + w * 0.73, ry + rowH / 2);
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
      ctx, 46, 170, 320, 620, COLORS.at, COLORS.at, "#fff",
      groups.airteltigo, drawAtLogo, "rgba(255,255,255,0.55)", 4, COLORS.telecel
    );
    drawGridColumn(ctx, 380, 170, 320, 620, COLORS.mtn, COLORS.mtn, "#111", groups.mtn, drawMtnLogo, "rgba(0,0,0,0.35)");
    drawGridColumn(ctx, 714, 170, 320, 520, COLORS.telecel, COLORS.telecel, "#fff", groups.telecel, drawTelecelLogo, "rgba(255,255,255,0.45)");

    const model = await cutout(MODELS.plug);
    ctx.drawImage(model, 520, 760, 620, 720);

    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 36px Montserrat, Outfit, sans-serif";
    ctx.fillText("Buy Affordable", 48, 920);
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "900 92px Montserrat, Outfit, sans-serif";
    ctx.fillText("Data", 48, 1018);
    ctx.fillStyle = COLORS.ink;
    ctx.font = "800 42px Montserrat, Outfit, sans-serif";
    ctx.fillText("Package", 48, 1072);
    ctx.font = "800 34px Montserrat, Outfit, sans-serif";
    ctx.fillText("DM or CALL", 48, 1140);
    ctx.fillStyle = COLORS.telecel;
    ctx.font = "900 58px Montserrat, Outfit, sans-serif";
    ctx.fillText(data.phone || "Add your number", 48, 1218);

    drawCaption(ctx, data.url);
  }

  async function drawPackage(ctx, data) {
    const bg = ctx.createRadialGradient(W * 0.7, H * 0.2, 40, W * 0.4, H * 0.5, 900);
    bg.addColorStop(0, "#1c5c43");
    bg.addColorStop(1, "#0b2f22");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.arc(90, 1280, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "800 42px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("♥", 90, 1294);

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
      { x: 40, y: 250, w: 320, border: COLORS.mtn, list: groups.mtn, logo: drawMtnLogo },
      { x: 380, y: 250, w: 320, border: "#cfd8e3", list: groups.airteltigo, logo: drawAtLogo },
      { x: 720, y: 250, w: 320, border: COLORS.telecel, list: groups.telecel, logo: drawTelecelLogo },
    ];
    cards.forEach((card) => {
      ctx.save();
      ctx.shadowColor = card.border;
      ctx.shadowBlur = 18;
      fillRound(ctx, card.x, card.y, card.w, 620, 28, "#123d2d");
      ctx.restore();
      ctx.lineWidth = 5;
      ctx.strokeStyle = card.border;
      roundRect(ctx, card.x, card.y, card.w, 620, 28);
      ctx.stroke();
      card.logo(ctx, card.x + card.w / 2, card.y + 58, 42);
      drawPriceLines(ctx, card.list, card.x + 6, card.y + 120, card.w - 12, 470, "#fff", "cedi");
    });

    const model = await cutout(MODELS.package);
    ctx.drawImage(model, 430, 780, 680, 720);

    fillRound(ctx, 40, 1260, 700, 88, 44, "#fff");
    fillRound(ctx, 70, 1228, 220, 36, 18, "#fff");
    ctx.strokeStyle = "#123d2d";
    ctx.lineWidth = 2;
    roundRect(ctx, 70, 1228, 220, 36, 18);
    ctx.stroke();
    ctx.fillStyle = "#123d2d";
    ctx.font = "700 16px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("To purchase contact,", 180, 1246);
    ctx.font = "800 32px Montserrat, Outfit, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`☎  ${data.phoneIntl || data.phone || "Add your number"}`, 70, 1306);

    drawCaption(ctx, data.url);
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

  function shopHeight(groups) {
    const cols = 4;
    const cardH = 208;
    const gap = 16;
    let h = 560;
    SHOP_NETS.forEach((net) => {
      const list = groups[net.key] || [];
      if (!list.length) return;
      const rows = Math.ceil(list.length / cols);
      h += 86 + rows * (cardH + gap) + 24;
    });
    return Math.max(1440, h + 140);
  }

  async function drawShop(ctx, data, canvas) {
    const accent = data.accent || "#2ec8e6";
    const onAccent = contrastInk(accent);
    const groups = byNetwork(data.packages);
    SHOP_NETS.forEach((net) => {
      groups[net.key] = (groups[net.key] || []).slice(0, 16);
    });
    const height = shopHeight(groups);
    canvas.height = height;
    canvas.width = W;

    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, W, height);
    const glow = ctx.createRadialGradient(W * 0.72, 40, 20, W * 0.55, 120, 640);
    glow.addColorStop(0, rgba(accent, 0.28));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, 520);

    const pad = 44;
    fillRound(ctx, pad, 36, 64, 64, 16, accent);
    drawBolt(ctx, pad + 4, 40, 56, onAccent);

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "800 34px Montserrat, Outfit, sans-serif";
    const storeName = String(data.name || "DATA HUB").toUpperCase();
    ctx.fillText(storeName, pad + 80, 68);
    ctx.fillStyle = accent;
    ctx.font = "600 16px Outfit, sans-serif";
    ctx.fillText((data.tagline || "Affordable. Instant. Reliable.").slice(0, 42), pad + 80, 96);

    fillRound(ctx, W - pad - 200, 44, 200, 48, 24, accent);
    ctx.fillStyle = onAccent;
    ctx.font = "800 16px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Visit store →", W - pad - 100, 68);

    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = "800 42px Montserrat, Outfit, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("DATA BUNDLES – ALL NETWORKS", pad, 180);
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.font = "600 20px Outfit, sans-serif";
    ctx.fillText("Affordable. Instant. Reliable.", pad, 214);

    const chips = [
      { label: "WHATSAPP / CALL", value: data.phone || "Add your number", bg: "#0f1720", color: "#fff" },
      { label: "WORKING HOURS", value: data.hours || "8am - 9pm Each day", bg: "#0f1720", color: "#fff" },
      { label: "CHAT ON WHATSAPP", value: "Chat now", bg: "#25d366", color: "#06240f" },
    ];
    const chipW = (W - pad * 2 - 24) / 3;
    chips.forEach((chip, i) => {
      const x = pad + i * (chipW + 12);
      fillRound(ctx, x, 242, chipW, 96, 18, chip.bg);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "700 13px Outfit, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(chip.label, x + 18, 272);
      ctx.fillStyle = chip.color;
      ctx.font = "800 22px Outfit, sans-serif";
      fitText(ctx, chip.value, chipW - 36, (s) => `800 ${s}px Outfit, sans-serif`);
      ctx.fillText(chip.value, x + 18, 308);
    });

    const visibleNets = SHOP_NETS.filter((net) => (groups[net.key] || []).length);
    const tabs = visibleNets.length ? visibleNets : SHOP_NETS;
    const tabW = (W - pad * 2 - 16 * (tabs.length - 1)) / tabs.length;
    tabs.forEach((net, i) => {
      const x = pad + i * (tabW + 16);
      fillRound(ctx, x, 364, tabW, 70, 16, net.btn);
      ctx.fillStyle = net.btnInk;
      ctx.font = "800 24px Montserrat, Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(net.tab, x + tabW / 2, 399);
    });

    let y = 470;
    const cols = 4;
    const gap = 16;
    const cardW = (W - pad * 2 - gap * (cols - 1)) / cols;
    const cardH = 208;

    visibleNets.forEach((net) => {
      const list = groups[net.key] || [];
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = net.ink;
      ctx.font = "800 28px Montserrat, Outfit, sans-serif";
      ctx.fillText(net.title, pad, y);
      net.key === "mtn" ? drawMtnLogo(ctx, W - pad - 28, y - 12, 24) : net.key === "telecel" ? drawTelecelLogo(ctx, W - pad - 28, y - 12, 24) : drawAtLogo(ctx, W - pad - 28, y - 12, 24);
      y += 28;

      list.forEach((pkg, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = pad + col * (cardW + gap);
        const cy = y + row * (cardH + gap);
        fillRound(ctx, x, cy, cardW, cardH, 18, "#0d1118");
        strokeRound(ctx, x, cy, cardW, cardH, 18, net.color, 3);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#fff";
        ctx.font = "800 34px Montserrat, Outfit, sans-serif";
        ctx.fillText(gbLabel(pkg.gb), x + 16, cy + 48);
        ctx.fillStyle = net.ink;
        ctx.font = "800 14px Outfit, sans-serif";
        ctx.fillText(net.name, x + 16, cy + 74);
        ctx.fillStyle = "#fff";
        ctx.font = "800 22px Montserrat, Outfit, sans-serif";
        ctx.fillText(priceLabel(pkg.price, "ghc"), x + 16, cy + 112);
        fillRound(ctx, x + 14, cy + cardH - 58, cardW - 28, 40, 10, net.btn);
        ctx.fillStyle = net.btnInk;
        ctx.font = "800 16px Outfit, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("BUY NOW", x + cardW / 2, cy + cardH - 38);
      });

      const rows = Math.ceil(list.length / cols);
      y += rows * (cardH + gap) + 36;
    });

    if (!visibleNets.length) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "700 24px Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Set store prices to fill this flyer.", W / 2, 620);
    }

    fillRound(ctx, pad, height - 92, W - pad * 2, 52, 16, accent);
    ctx.fillStyle = onAccent;
    ctx.font = "700 20px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = String(data.url || "").replace(/^https?:\/\//, "");
    fitText(ctx, label, W - pad * 2 - 40, (s) => `700 ${s}px Outfit, sans-serif`);
    ctx.fillText(label, W / 2, height - 66);
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

  return { render, download, templates: ["shop", "hub", "plug", "package"] };
})();
