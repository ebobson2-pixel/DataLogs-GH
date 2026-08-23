(function receiptModule() {
  function receiptHtml(data) {
    const when = data.createdAt ? formatOrderDateTime(data.createdAt).full : new Date().toLocaleString();
    const status = publicDeliveryLabel(data.status);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Receipt ${escapeHtml(data.orderCode || "")}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f7f8;color:#111;margin:0;padding:24px}
  .sheet{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  h1{margin:0 0 4px;font-size:1.5rem}.brand{color:#2ec8e6;font-weight:800}
  .ok{color:#16a34a;font-weight:700}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #eee}
  .row span{color:#666}.foot{margin-top:18px;color:#666;font-size:.9rem}
</style></head><body>
<div class="sheet">
  <p class="brand">DataLogs GH</p>
  <h1>Payment receipt</h1>
  <p class="ok">${escapeHtml(status)}</p>
  <div class="row"><span>Order</span><strong>${escapeHtml(data.orderCode || "—")}</strong></div>
  <div class="row"><span>Network</span><strong>${escapeHtml(data.networkName || data.network || "—")}</strong></div>
  <div class="row"><span>Bundle</span><strong>${escapeHtml(String(data.gb || "—"))} GB</strong></div>
  <div class="row"><span>Recipient</span><strong>${escapeHtml(data.recipient || "—")}</strong></div>
  <div class="row"><span>Amount</span><strong>${escapeHtml(formatCedi(data.amount || 0))}</strong></div>
  <div class="row"><span>Payment</span><strong>${escapeHtml(data.method || "—")}</strong></div>
  <div class="row"><span>Date</span><strong>${escapeHtml(when)}</strong></div>
  <p class="foot">Thank you for using DataLogs GH · datalogs.shop</p>
</div></body></html>`;
  }

  function downloadReceipt(data) {
    const html = receiptHtml(data);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(data.orderCode || "receipt").replace(/[^\w-]+/g, "-")}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function shareReceipt(data) {
    const text = [
      "DataLogs GH receipt",
      `${data.networkName || data.network} ${data.gb}GB → ${data.recipient}`,
      `Amount: ${formatCedi(data.amount || 0)}`,
      `Order: ${data.orderCode}`,
      `Status: ${publicDeliveryLabel(data.status)}`,
      "https://datalogs.shop",
    ].join("\n");
    if (navigator.share) {
      navigator.share({ title: "DataLogs receipt", text }).catch(() => {});
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    }
  }

  window.DataLogsReceipt = { downloadReceipt, shareReceipt, receiptHtml };
})();
