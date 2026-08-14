(function whatsappFab() {
  if (document.getElementById("whatsapp-fab-root")) return;
  if (document.body.classList.contains("dash-body")) return;
  if (document.body.classList.contains("store-body")) return;
  if (!window.DataLogsAPI?.getSiteSettings) return;

  function safeHref(value) {
    try {
      const url = new URL(String(value).trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch {
      return "";
    }
  }

  const root = document.createElement("div");
  root.id = "whatsapp-fab-root";
  document.body.appendChild(root);

  DataLogsAPI.getSiteSettings()
    .then((settings) => {
      const url = safeHref(settings?.whatsapp_channel_url || "");
      if (!url) {
        root.remove();
        return;
      }
      root.innerHTML = `
        <a class="wa-fab" href="${url.replace(/"/g, "")}" target="_blank" rel="noopener noreferrer" aria-label="Open DataLogs Ghana WhatsApp channel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm.01 18.14c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.26 8.26 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24 4.54 0 8.24 3.7 8.24 8.24 0 4.54-3.7 8.24-8.23 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.79.97-.15.17-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.42h-.48c-.17 0-.43.06-.66.31-.23.25-.87.85-.87 2.07s.89 2.4 1.01 2.56c.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.23-.16-.48-.29z"/></svg>
          <span>Channel</span>
        </a>
      `;
    })
    .catch(() => {
      root.remove();
    });
})();
