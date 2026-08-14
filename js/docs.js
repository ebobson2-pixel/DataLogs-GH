(function docsPage() {
  const statusEl = document.getElementById("api-status");
  if (!statusEl) return;
  const base = window.DATALOGS_CONFIG?.apiBase || "https://datalogsgh.shop/api/v1";
  const fallback = `${window.DATALOGS_CONFIG?.supabaseUrl || ""}/functions/v1/agent-api/health`;

  async function ping(url) {
    const headers = {};
    if (url.includes("supabase.co") && window.DATALOGS_CONFIG?.supabaseAnonKey) {
      headers.apikey = window.DATALOGS_CONFIG.supabaseAnonKey;
    }
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.ok;
  }

  (async () => {
    try {
      const live = await ping(`${base}/health`);
      if (live) {
        statusEl.textContent = "API is live · https://datalogsgh.shop/api/v1";
        statusEl.classList.add("is-up");
        return;
      }
    } catch {
      /* try function URL */
    }
    try {
      const live = fallback.startsWith("http") && (await ping(fallback));
      if (live) {
        statusEl.textContent = "API is live";
        statusEl.classList.add("is-up");
        return;
      }
    } catch {
      /* show down */
    }
    statusEl.textContent = "Could not reach the API from this browser. Try again in a moment.";
    statusEl.classList.add("is-down");
  })();
})();
