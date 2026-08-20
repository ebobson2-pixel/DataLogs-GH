(function () {
  var s = " stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"";
  var icons = {
    overview: "<svg viewBox=\"0 0 24 24\"" + s + "><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"/></svg>",
    store: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z\"/><path d=\"M9 22V12h6v10\"/></svg>",
    flyer: "<svg viewBox=\"0 0 24 24\"" + s + "><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><circle cx=\"8.5\" cy=\"8.5\" r=\"1.5\"/><path d=\"M21 15l-5-5L5 21\"/></svg>",
    pricing: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/></svg>",
    wholesale: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\"/><path d=\"M3.3 7l8.7 5 8.7-5M12 22V12\"/></svg>",
    orders: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01\"/></svg>",
    customers: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75\"/></svg>",
    wallet: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M19 7V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1\"/><path d=\"M3 10h18v4H3z\"/><path d=\"M16 14h.01\"/></svg>",
    withdrawal: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M12 19V5M5 12l7-7 7 7\"/></svg>",
    developer: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M16 18l6-6-6-6M8 6l-6 6 6 6\"/></svg>",
    account: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>",
    logout: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/></svg>",
    menu: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M4 6h16M4 12h16M4 18h16\"/></svg>",
    settings: "<svg viewBox=\"0 0 24 24\"" + s + "><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42\"/></svg>",
    collapse: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M15 18l-6-6 6-6\"/></svg>",
    expand: "<svg viewBox=\"0 0 24 24\"" + s + "><path d=\"M9 18l6-6-6-6\"/></svg>"
  };

  function paint(el) {
    if (!el) return;
    var key = el.getAttribute("data-icon");
    if (key && icons[key]) el.innerHTML = icons[key];
  }

  function paintAll(root) {
    (root || document).querySelectorAll("[data-icon]").forEach(paint);
  }

  window.DashIcons = { paint: paint, paintAll: paintAll, icons: icons };
  paintAll();
})();
