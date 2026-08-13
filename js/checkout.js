(function checkout() {
  const root = document.getElementById("checkout-root");
  if (!root) return;

  const state = {
    pkg: null,
    number: "",
    method: "momo",
    tier: "retail",
    storeId: null,
    order: null,
  };

  root.innerHTML = `
    <div class="modal-backdrop" id="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <div class="modal"></div>
    </div>
  `;

  const backdrop = root.querySelector("#checkout-modal");
  const modal = root.querySelector(".modal");

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-buy]");
    if (!trigger) return;
    const pkg = getPackage(trigger.dataset.buy);
    if (!pkg) return;
    state.pkg = { ...pkg };
    state.tier = trigger.dataset.tier === "agent" ? "agent" : "retail";
    if (state.tier === "agent") state.pkg.price = pkg.agentPrice;
    state.storeId = trigger.dataset.storeId || window.__STORE_ID || null;
    state.number = "";
    state.method = "momo";
    state.order = null;
    openStep("number");
  });

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });

  function openStep(step) {
    backdrop.classList.add("open");
    if (step === "number") renderNumber();
    if (step === "pay") renderPay();
    if (step === "process") renderProcess();
    if (step === "done") renderDone();
  }

  function closeModal() {
    backdrop.classList.remove("open");
  }

  function networkName() {
    return NETWORKS[state.pkg.network].name;
  }

  function priceHint() {
    if (state.tier === "agent") {
      return `Agent rate ${formatCedi(state.pkg.price)} · retail ${formatCedi(state.pkg.retail)} · ${state.pkg.validity}`;
    }
    return `${formatCedi(state.pkg.price)} · valid ${state.pkg.validity}`;
  }

  function renderNumber() {
    const prefixes = NETWORKS[state.pkg.network].prefixes.join(", ");
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">${state.tier === "agent" ? "Agent wholesale · " : ""}${networkName()} · ${state.pkg.gb} GB</div>
          <h3 id="checkout-title">Who should receive this bundle?</h3>
          <p class="hint">${priceHint()}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <form class="form" id="number-form">
        <label>
          Recipient number
          <input id="recipient" inputmode="tel" autocomplete="tel" placeholder="024 123 4567" value="${state.number}" required>
        </label>
        <p class="hint">Use a Ghana ${networkName()} number. Prefixes: ${prefixes}</p>
        <p class="error" id="number-error" hidden></p>
        <button class="btn btn-primary btn-full" type="submit">Continue to payment</button>
      </form>
    `;
    wireClose();
    modal.querySelector("#number-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = modal.querySelector("#recipient").value;
      const result = validateGhanaNumber(raw, state.pkg.network);
      const error = modal.querySelector("#number-error");
      if (!result.ok) {
        error.hidden = false;
        error.textContent = result.message;
        return;
      }
      state.number = result.pretty;
      openStep("pay");
    });
  }

  function renderPay() {
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">Step 2 of 2</div>
          <h3 id="checkout-title">Pay for ${state.pkg.gb} GB</h3>
          <p class="hint">Sending to ${state.number} on ${networkName()}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="pay-methods" role="list">
        ${payButton("momo", "Mobile Money", "MTN MoMo, Telecel Cash or AT Money")}
        ${payButton("card", "Debit / credit card", "Visa or Mastercard")}
      </div>
      <p class="demo-note">Payment is recorded in Supabase. Network delivery is fulfilled from the admin queue.</p>
      <div class="hero-actions" style="margin-top:16px">
        <button class="btn btn-ghost" type="button" data-back>Back</button>
        <button class="btn btn-primary btn-full" type="button" data-pay>Pay ${formatCedi(state.pkg.price)}</button>
      </div>
      <p class="error" id="pay-error" hidden></p>
    `;
    wireClose();
    modal.querySelectorAll("[data-method]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.method = btn.dataset.method;
        renderPay();
      });
    });
    modal.querySelector("[data-back]").addEventListener("click", () => openStep("number"));
    modal.querySelector("[data-pay]").addEventListener("click", () => openStep("process"));
  }

  function payButton(id, title, subtitle) {
    return `
      <button class="pay-method ${state.method === id ? "selected" : ""}" type="button" data-method="${id}">
        <strong>${title}</strong>
        <span class="hint">${subtitle}</span>
      </button>
    `;
  }

  async function renderProcess() {
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">Processing</div>
          <h3 id="checkout-title">Saving your order…</h3>
        </div>
      </div>
      <ul class="progress-list">
        <li class="active" data-step="pay"><span class="dot"></span> Recording payment</li>
        <li data-step="net"><span class="dot"></span> Queuing ${networkName()} delivery</li>
        <li data-step="send"><span class="dot"></span> Confirming ${state.pkg.gb} GB to ${state.number}</li>
      </ul>
    `;

    try {
      if (state.tier === "agent") {
        const session = await DataLogsAPI.getSession();
        if (!session) throw new Error("Sign in as an agent to buy wholesale.");
      }

      const order = await DataLogsAPI.placeOrder({
        packageId: state.pkg.id,
        recipientNumber: state.number,
        paymentMethod: state.method,
        pricingTier: state.tier,
        agentStoreId: state.storeId,
      });
      state.order = order;

      modal.querySelector('[data-step="pay"]').classList.add("done");
      modal.querySelector('[data-step="pay"]').classList.remove("active");
      modal.querySelector('[data-step="net"]').classList.add("active");
      await wait(500);
      modal.querySelector('[data-step="net"]').classList.add("done");
      modal.querySelector('[data-step="net"]').classList.remove("active");
      modal.querySelector('[data-step="send"]').classList.add("active");
      await wait(500);
      modal.querySelector('[data-step="send"]').classList.add("done");
      window.dispatchEvent(new CustomEvent("datalogs:order-placed", { detail: order }));
      openStep("done");
    } catch (err) {
      modal.innerHTML = `
        <div class="modal-top">
          <div>
            <h3 id="checkout-title">Order failed</h3>
            <p class="error">${err.message || "Could not place order."}</p>
          </div>
          <button class="close-btn" type="button" data-close aria-label="Close">×</button>
        </div>
        <button class="btn btn-primary btn-full" type="button" data-back>Try again</button>
      `;
      wireClose();
      modal.querySelector("[data-back]").addEventListener("click", () => openStep("pay"));
    }
  }

  function renderDone() {
    const order = state.order;
    modal.innerHTML = `
      <div class="success-mark" aria-hidden="true">✓</div>
      <h3 id="checkout-title">Order placed</h3>
      <p class="hint">${state.pkg.gb} GB for ${state.number} on ${networkName()} is queued for delivery.</p>
      <div class="receipt">
        <div><span>Order</span><strong>${order.order_code}</strong></div>
        <div><span>Network</span><strong>${networkName()}</strong></div>
        <div><span>Package</span><strong>${state.pkg.gb} GB</strong></div>
        <div><span>Paid</span><strong>${formatCedi(order.amount_paid)}</strong></div>
        <div><span>Status</span><strong>${order.delivery_status}</strong></div>
        <div><span>Method</span><strong>${state.method === "momo" ? "Mobile Money" : "Card"}</strong></div>
      </div>
      <button class="btn btn-primary btn-full" type="button" data-close>Done</button>
    `;
    wireClose();
  }

  function wireClose() {
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", closeModal));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
