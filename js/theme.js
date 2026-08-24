(function (global) {
  const THEME_KEY = "datalogs_theme";
  const ACCENT_KEY = "datalogs_accent";
  const ACCENTS = [
    { id: "green", label: "Green", hex: "#16a34a" },
    { id: "sea", label: "Sea", hex: "#2ec8e6" },
    { id: "gold", label: "Gold", hex: "#f5c400" },
    { id: "lime", label: "Lime", hex: "#a3e635" },
    { id: "violet", label: "Violet", hex: "#a78bfa" },
    { id: "coral", label: "Coral", hex: "#fb7185" },
    { id: "orange", label: "Orange", hex: "#fb923c" },
    { id: "mint", label: "Mint", hex: "#2dd4bf" },
    { id: "sky", label: "Sky", hex: "#38bdf8" },
    { id: "beige", label: "Beige", hex: "#d4b896" },
  ];
  let uid = 0;
  let docBound = false;

  function currentTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function currentAccent() {
    try {
      const id = localStorage.getItem(ACCENT_KEY);
      return ACCENTS.some((a) => a.id === id) ? id : "sea";
    } catch {
      return "sea";
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    document.querySelectorAll(".theme-toggle").forEach((btn) => {
      btn.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
    });
  }

  function applyAccent(id) {
    const accent = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
    document.documentElement.setAttribute("data-accent", accent.id);
    try {
      localStorage.setItem(ACCENT_KEY, accent.id);
    } catch {
      /* ignore */
    }
    document.querySelectorAll(".accent-swatch").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.accent === accent.id));
    });
  }

  function toolsHTML() {
    const id = `accent-swatches-${++uid}`;
    return `
      <div class="accent-picker">
        <button class="accent-toggle" type="button" aria-label="Choose accent color" aria-expanded="false" aria-controls="${id}">
          <span class="accent-dot" aria-hidden="true"></span>
        </button>
        <div class="accent-swatches" id="${id}" role="listbox" aria-label="Accent colors" hidden>
          ${ACCENTS.map(
            (a) => `<button class="accent-swatch" type="button" role="option" data-accent="${a.id}" aria-label="${a.label}" aria-checked="false" style="background:${a.hex}"></button>`
          ).join("")}
        </div>
      </div>
      <button class="theme-toggle" type="button" aria-label="Switch to light theme">
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
        </svg>
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"></path>
        </svg>
      </button>
    `;
  }

  function closePickers(except) {
    document.querySelectorAll(".accent-picker").forEach((picker) => {
      if (picker === except) return;
      const swatches = picker.querySelector(".accent-swatches");
      const btn = picker.querySelector(".accent-toggle");
      if (swatches) swatches.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  function bind(root) {
    if (!root) return;
    const picker = root.querySelector(".accent-picker");
    const accentBtn = root.querySelector(".accent-toggle");
    const swatches = root.querySelector(".accent-swatches");
    const themeBtn = root.querySelector(".theme-toggle");
    if (themeBtn && !themeBtn.dataset.themeBound) {
      themeBtn.dataset.themeBound = "true";
      themeBtn.addEventListener("click", () => {
        applyTheme(currentTheme() === "light" ? "dark" : "light");
      });
    }
    if (picker && accentBtn && swatches && !picker.dataset.themeBound) {
      picker.dataset.themeBound = "true";
      const setOpen = (open) => {
        swatches.hidden = !open;
        accentBtn.setAttribute("aria-expanded", String(open));
      };
      accentBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = swatches.hidden;
        closePickers(picker);
        setOpen(willOpen);
      });
      swatches.addEventListener("click", (event) => {
        const swatch = event.target.closest("[data-accent]");
        if (!swatch) return;
        applyAccent(swatch.dataset.accent);
        setOpen(false);
      });
    }
    applyTheme(currentTheme());
    applyAccent(currentAccent());
  }

  function mount(selector) {
    document.querySelectorAll(selector || "[data-theme-tools]").forEach((el) => {
      if (el.dataset.themeMounted) return;
      el.innerHTML = toolsHTML();
      el.classList.add("nav-tools");
      el.dataset.themeMounted = "true";
      bind(el);
    });
  }

  function bindDocument() {
    if (docBound) return;
    docBound = true;
    document.addEventListener("click", (event) => {
      if (event.target.closest(".accent-picker")) return;
      closePickers();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePickers();
    });
  }

  applyTheme(currentTheme());
  applyAccent(currentAccent());

  function start() {
    bindDocument();
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  function accentById(id) {
    return ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  }

  function accentHex(id) {
    return accentById(id).hex;
  }

  global.DataLogsTheme = {
    ACCENTS,
    currentTheme,
    currentAccent,
    applyTheme,
    applyAccent,
    accentById,
    accentHex,
    toolsHTML,
    bind,
    mount,
  };
})(window);
