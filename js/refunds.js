(function refundsModule() {
  const REASONS = [
    { id: "data_not_received", label: "Data not received" },
    { id: "payment_deducted_failed", label: "Money deducted but transaction failed" },
    { id: "stuck_processing", label: "Transaction stuck / processing too long" },
    { id: "duplicate_charge", label: "Duplicate charge" },
    { id: "incorrect_amount", label: "Incorrect amount charged" },
    { id: "wrong_number", label: "Wrong phone number" },
    { id: "other", label: "Other issue" },
  ];

  const STATUS_LABEL = {
    requested: "🟡 Requested",
    under_review: "🔵 Under review",
    approved: "🟢 Approved",
    rejected: "🔴 Rejected",
    processing: "🟡 Processing",
    completed: "🟢 Completed",
    failed: "🔴 Failed",
    cancelled: "⚪ Cancelled",
  };

  function statusLabel(s) {
    return STATUS_LABEL[s] || s;
  }

  function reasonLabel(id) {
    return REASONS.find((r) => r.id === id)?.label || id;
  }

  function timelineHtml(events) {
    if (!events?.length) return "";
    return `<ol class="refund-timeline">${events
      .map(
        (e) => `
      <li class="done">
        <span class="track-timeline-dot"></span>
        <span><strong>${escapeHtml(e.action.replace(/_/g, " "))}</strong>
        ${e.to_status ? ` · ${statusLabel(e.to_status)}` : ""}
        <br><span class="hint">${escapeHtml(formatOrderDateTime(e.created_at).full)}</span></span>
      </li>`
      )
      .join("")}</ol>`;
  }

  function downloadRefundReceipt(refund, order) {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${refund.refund_code}</title>
<style>body{font-family:system-ui,sans-serif;padding:24px;background:#f4f7f8}
.sheet{max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:16px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}
.row span{color:#666}.brand{color:#2ec8e6;font-weight:800}</style></head><body>
<div class="sheet"><p class="brand">DataLogs GH</p><h1>Refund receipt</h1>
<div class="row"><span>Refund reference</span><strong>${escapeHtml(refund.refund_code)}</strong></div>
<div class="row"><span>Original transaction</span><strong>${escapeHtml(refund.order_code)}</strong></div>
<div class="row"><span>Network</span><strong>${escapeHtml(NETWORKS[order?.network]?.name || order?.network || "—")}</strong></div>
<div class="row"><span>Bundle</span><strong>${escapeHtml(String(order?.gb || "—"))} GB</strong></div>
<div class="row"><span>Refund amount</span><strong>${escapeHtml(formatCedi(refund.amount))}</strong></div>
<div class="row"><span>Reason</span><strong>${escapeHtml(reasonLabel(refund.reason))}</strong></div>
<div class="row"><span>Status</span><strong>${escapeHtml(statusLabel(refund.status))}</strong></div>
<div class="row"><span>Date</span><strong>${escapeHtml(formatOrderDateTime(refund.created_at).full)}</strong></div>
</div></body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${refund.refund_code}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function paintRefundList(container, phone) {
    const rows = await DataLogsAPI.listMyRefunds(phone);
    if (!rows.length) {
      container.innerHTML = `<p class="hint">No refund requests yet.</p>`;
      return;
    }
    container.innerHTML = rows
      .map(
        (r) => `
      <article class="track-card ${r.status === "completed" ? "is-delivered" : r.status === "failed" || r.status === "rejected" ? "is-failed" : "is-processing"}">
        <div class="track-card-top">
          <strong>${escapeHtml(r.refund_code)}</strong>
          <span class="track-status">${statusLabel(r.status)}</span>
        </div>
        <p class="track-meta">Order ${escapeHtml(r.order_code)} · ${formatCedi(r.amount)}</p>
        <p class="hint">${escapeHtml(reasonLabel(r.reason))}</p>
        <button class="btn btn-ghost btn-sm" type="button" data-view-refund="${escapeHtml(r.refund_code)}">View details</button>
      </article>`
      )
      .join("");
    container.querySelectorAll("[data-view-refund]").forEach((btn) => {
      btn.addEventListener("click", () => showRefundDetail(btn.dataset.viewRefund, phone));
    });
  }

  async function showRefundDetail(code, phone) {
    const detail = await DataLogsAPI.getRefundDetail(code, phone);
    const panel = document.getElementById("refund-detail-panel");
    if (!panel) return;
    const rf = detail.refund;
    const ord = detail.order;
    panel.hidden = false;
    panel.innerHTML = `
      <div class="panel-card">
        <h3>${escapeHtml(rf.refund_code)}</h3>
        <p>${statusLabel(rf.status)} · ${formatCedi(rf.amount)}</p>
        <p class="hint">${escapeHtml(reasonLabel(rf.reason))}</p>
        ${rf.support_ticket_code ? `<p class="hint">Support ticket: <strong>${escapeHtml(rf.support_ticket_code)}</strong></p>` : ""}
        ${timelineHtml(detail.events)}
        <div class="hero-actions" style="margin-top:12px">
          <button class="btn btn-ghost" type="button" id="refund-receipt-dl">Download receipt</button>
          <a class="btn btn-ghost" href="../contact.html">Contact support</a>
        </div>
      </div>`;
    panel.querySelector("#refund-receipt-dl")?.addEventListener("click", () => downloadRefundReceipt(rf, ord));
  }

  async function runEligibility(form) {
    const orderCode = form.order_code.value.trim();
    const reason = form.reason.value;
    const phone = form.phone?.value?.trim() || "";
    const resultEl = document.getElementById("refund-eligibility-result");
    const errorEl = document.getElementById("refund-form-error");
    errorEl.hidden = true;
    resultEl.innerHTML = `<p class="hint">Checking transaction…</p>`;
    try {
      const chk = await DataLogsAPI.checkRefundEligibility(orderCode, reason, phone);
      if (chk.existing) {
        resultEl.innerHTML = `<p><strong>Existing refund:</strong> ${escapeHtml(chk.refund_code)} · ${statusLabel(chk.status)}</p>`;
        form.dataset.existing = "1";
        return;
      }
      form.dataset.existing = "0";
      const eligible = chk.eligible;
      const cls = eligible === "not_eligible" ? "error" : "recipient-confirm";
      const title =
        eligible === "not_eligible"
          ? "Not eligible yet"
          : eligible === "auto_eligible"
            ? "Refund eligible — admin approval required"
            : "Refund review required";
      resultEl.innerHTML = `
        <div class="${cls}" style="margin-top:12px;padding:14px;border-radius:12px">
          <p><strong>${title}</strong></p>
          <p class="hint">${escapeHtml(chk.message || "")}</p>
          <p class="hint">All refunds are reviewed by an administrator before any money is returned.</p>
          ${eligible !== "not_eligible" ? `<p>Amount: <strong>${formatCedi(chk.amount)}</strong></p>` : ""}
          ${chk.duplicate_detected ? `<p class="hint">Duplicate transaction detected.</p>` : ""}
        </div>`;
      form.dataset.canSubmit = eligible !== "not_eligible" ? "1" : "0";
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.message || "Could not check eligibility.";
      resultEl.innerHTML = "";
    }
  }

  async function submitRefund(form) {
    const errorEl = document.getElementById("refund-form-error");
    const okEl = document.getElementById("refund-form-ok");
    errorEl.hidden = true;
    okEl.hidden = true;
    if (form.dataset.canSubmit !== "1" && form.dataset.existing !== "1") {
      errorEl.hidden = false;
      errorEl.textContent = "Check eligibility first.";
      return;
    }
    try {
      const orderCode = form.order_code.value.trim();
      const reason = form.reason.value;
      const phone = form.phone?.value?.trim() || "";
      const detail = form.detail?.value?.trim() || "";
      const created = await DataLogsAPI.createRefundRequest(orderCode, reason, detail, phone);
      if (created.existing) {
        okEl.hidden = false;
        okEl.textContent = `Existing refund ${created.refund_code} · ${statusLabel(created.status)}`;
        return;
      }
      const confirmed = await DataLogsAPI.confirmRefundRequest(created.refund_id);
      const rf = confirmed.refund;
      okEl.hidden = false;
      okEl.textContent =
        confirmed.message ||
        `Refund ${rf.refund_code} submitted · ${statusLabel(rf.status)} · awaiting admin approval`;
      const list = document.getElementById("refund-list");
      if (list) paintRefundList(list, phone);
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.message || "Could not submit refund request.";
    }
  }

  function initPage() {
    const form = document.getElementById("refund-request-form");
    const list = document.getElementById("refund-list");
    const params = new URLSearchParams(window.location.search);
    if (params.get("order") && form?.order_code) {
      form.order_code.value = params.get("order");
    }
    const phoneInput = form?.querySelector("[name=phone]");
    if (phoneInput && window.DataLogsCustomer?.getMyPhone) {
      phoneInput.value = window.DataLogsCustomer.getMyPhone() || "";
    }
    form?.querySelector("#refund-check-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      runEligibility(form);
    });
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitRefund(form);
    });
    if (list) paintRefundList(list, phoneInput?.value || "").catch(() => {});
  }

  window.DataLogsRefunds = {
    REASONS,
    statusLabel,
    reasonLabel,
    timelineHtml,
    initPage,
    paintRefundList,
    showRefundDetail,
    downloadRefundReceipt,
  };

  if (document.body.classList.contains("refunds-page")) {
    initPage();
  }
})();
