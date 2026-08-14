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
    fulfill: null,
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
    state.email = "";
    state.momoPhone = "";
    state.momoProvider = pkg.network === "airteltigo" ? "airteltigo" : pkg.network === "telecel" ? "telecel" : "mtn";
    state.card = { number: "", month: "", year: "", cvv: "" };
    state.reference = null;
    state.order = null;
    state.fulfill = null;
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
    const walletOpt =
      state.tier === "agent"
        ? payButton("wallet", "Pay from wallet", "Use your DataLogs GH wallet balance")
        : "";
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">Pay in this window</div>
          <h3 id="checkout-title">Pay ${formatCedi(state.pkg.price)}</h3>
          <p class="hint">Sending ${state.pkg.gb} GB to ${state.number} on ${networkName()}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="pay-methods" role="list">
        ${payButton("momo", "Mobile Money", "MTN, Telecel Cash or AT Money")}
        ${payButton("card", "Debit / credit card", "Visa or Mastercard")}
        ${walletOpt}
      </div>
      <form class="form pay-form" id="pay-form" style="margin-top:14px">
        ${state.method === "wallet" ? walletFields() : payFields()}
        <p class="error" id="pay-error" hidden></p>
        <div class="hero-actions" style="margin-top:12px">
          <button class="btn btn-ghost" type="button" data-back>Back</button>
          <button class="btn btn-primary btn-full" type="submit">${
            state.method === "wallet" ? "Pay from wallet" : `Pay ${formatCedi(state.pkg.price)}`
          }</button>
        </div>
      </form>
    `;
    wireClose();
    preloadPayDefaults();
    modal.querySelectorAll("[data-method]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.method = btn.dataset.method;
        renderPay();
      });
    });
    modal.querySelector("[data-back]").addEventListener("click", () => openStep("number"));
    modal.querySelector("#pay-form").addEventListener("submit", (event) => {
      event.preventDefault();
      collectPayForm();
      openStep("process");
    });
  }

  function payFields() {
    if (state.method === "card") {
      return `
        <label>Email for receipt
          <input id="pay-email" type="email" required placeholder="you@email.com" value="${escapeHtml(state.email)}">
        </label>
        <label>Card number
          <input id="card-number" inputmode="numeric" autocomplete="cc-number" required placeholder="ACCT-000015" value="${escapeHtml(state.card.number)}">
        </label>
        <div class="split card-expiry">
          <label>Month<input id="card-month" inputmode="numeric" maxlength="2" required placeholder="MM" value="${escapeHtml(state.card.month)}"></label>
          <label>Year<input id="card-year" inputmode="numeric" maxlength="2" required placeholder="YY" value="${escapeHtml(state.card.year)}"></label>
          <label>CVV<input id="card-cvv" inputmode="numeric" maxlength="4" required placeholder="123" value="${escapeHtml(state.card.cvv)}"></label>
        </div>
        <p class="hint">You stay on DataLogs GH. Card details go to Paystack to confirm the charge.</p>
      `;
    }
    return `
      <label>Email for receipt
        <input id="pay-email" type="email" required placeholder="you@email.com" value="${escapeHtml(state.email)}">
      </label>
      <label>Mobile Money network
        <select id="momo-provider">
          <option value="mtn" ${state.momoProvider === "mtn" ? "selected" : ""}>MTN MoMo</option>
          <option value="telecel" ${state.momoProvider === "telecel" ? "selected" : ""}>Telecel Cash</option>
          <option value="airteltigo" ${state.momoProvider === "airteltigo" ? "selected" : ""}>AT Money</option>
        </select>
      </label>
      <label>MoMo number
        <input id="momo-phone" inputmode="tel" required placeholder="024 123 4567" value="${escapeHtml(state.momoPhone || state.number)}">
      </label>
      <p class="hint">Approve the prompt on your phone. We only mark the order paid after Paystack confirms it.</p>
    `;
  }

  function walletFields() {
    return `<p class="hint">This wholesale pack will be paid from your agent wallet. If the balance is too low, top up first.</p>`;
  }

  async function preloadPayDefaults() {
    if (state.email) return;
    try {
      const profile = await DataLogsAPI.getProfile();
      if (profile?.email || profile?.authEmail) {
        state.email = profile.email || profile.authEmail;
        const input = modal.querySelector("#pay-email");
        if (input && !input.value) input.value = state.email;
      }
    } catch {
      /* guests type an email */
    }
  }

  function collectPayForm() {
    const email = modal.querySelector("#pay-email");
    if (email) state.email = email.value.trim();
    const provider = modal.querySelector("#momo-provider");
    if (provider) state.momoProvider = provider.value;
    const phone = modal.querySelector("#momo-phone");
    if (phone) state.momoPhone = phone.value.trim();
    const number = modal.querySelector("#card-number");
    if (number) {
      state.card = {
        number: number.value,
        month: modal.querySelector("#card-month").value,
        year: modal.querySelector("#card-year").value,
        cvv: modal.querySelector("#card-cvv").value,
      };
    }
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
          <div class="pill">Secure payment</div>
          <h3 id="checkout-title">Confirming payment…</h3>
          <p class="hint" id="pay-hint">Stay on this page. We wait for Paystack to confirm before sending data.</p>
        </div>
      </div>
      <ul class="progress-list">
        <li class="active" data-step="pay"><span class="dot"></span> Taking payment</li>
        <li data-step="net"><span class="dot"></span> Sending ${networkName()} to the provider</li>
        <li data-step="send"><span class="dot"></span> Confirming ${state.pkg.gb} GB to ${state.number}</li>
      </ul>
      <form class="form" id="pay-challenge" hidden>
        <label id="challenge-label">Code
          <input id="challenge-input" required>
        </label>
        <p class="error" id="challenge-error" hidden></p>
        <button class="btn btn-primary btn-full" type="submit">Continue</button>
      </form>
    `;

    try {
      if (state.method === "wallet") {
        const session = await DataLogsAPI.getSession();
        if (!session) throw new Error("Sign in as an agent to pay with wallet.");
        const order = await DataLogsAPI.placeOrderWithWallet({
          packageId: state.pkg.id,
          recipientNumber: state.number,
        });
        state.order = order;
        await afterPaid();
        return;
      }

      const charged = await DataLogsPay.charge({
        kind: "order",
        channel: state.method === "card" ? "card" : "momo",
        email: state.email,
        packageId: state.pkg.id,
        recipientNumber: state.number,
        pricingTier: state.tier,
        agentStoreId: state.storeId,
        momo: { phone: state.momoPhone || state.number, provider: state.momoProvider },
        card: state.method === "card" ? {
          number: state.card.number,
          cvv: state.card.cvv,
          expiry_month: state.card.month,
          expiry_year: state.card.year,
        } : undefined,
      });
      state.reference = charged.reference;
      await handlePaystackNext(charged);
    } catch (err) {
      showPayError(err.message || "Could not start payment.");
    }
  }

  async function handlePaystackNext(result) {
    const hint = modal.querySelector("#pay-hint");
    const title = modal.querySelector("#checkout-title");
    if (result.next === "success") {
      await waitForPaidOrder(result);
      return;
    }
    if (result.next === "failed") throw new Error(result.display_text || "Payment failed.");
    if (hint) hint.textContent = result.display_text || "Complete the payment on your phone.";
    if (title) title.textContent = result.next === "offline" ? "Approve on your phone" : "Extra confirmation needed";
    if (result.url) window.open(String(result.url), "_blank", "noopener");

    if (result.next === "otp" || result.next === "pin" || result.next === "phone") {
      const form = modal.querySelector("#pay-challenge");
      const input = modal.querySelector("#challenge-input");
      const label = modal.querySelector("#challenge-label");
      form.hidden = false;
      input.value = "";
      input.placeholder = result.next === "pin" ? "PIN" : result.next === "otp" ? "OTP" : "Phone number";
      label.firstChild.textContent = result.next === "pin" ? "Card PIN" : result.next === "otp" ? "OTP" : "Phone";
      form.onsubmit = async (event) => {
        event.preventDefault();
        const error = modal.querySelector("#challenge-error");
        error.hidden = true;
        try {
          const next =
            result.next === "pin"
              ? await DataLogsPay.submitPin(state.reference, input.value)
              : result.next === "phone"
                ? await DataLogsPay.submitPhone(state.reference, input.value)
                : await DataLogsPay.submitOtp(state.reference, input.value);
          form.hidden = true;
          await handlePaystackNext(next);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message || "Could not continue.";
        }
      };
      return;
    }

    await waitForPaidOrder(result);
  }

  async function waitForPaidOrder(initial) {
    if (initial?.order) {
      state.order = initial.order;
      await afterPaid();
      return;
    }
    const started = Date.now();
    while (Date.now() - started < 180000) {
      await wait(3000);
      const status = await DataLogsPay.status(state.reference);
      if (status.status === "failed" || status.status === "abandoned") {
        throw new Error("Payment was not completed.");
      }
      if (status.status === "success" && status.order) {
        state.order = status.order;
        await afterPaid();
        return;
      }
    }
    throw new Error("Still waiting for Paystack confirmation. Keep this page open or track the order shortly.");
  }

  async function afterPaid() {
    modal.querySelector('[data-step="pay"]')?.classList.add("done");
    modal.querySelector('[data-step="pay"]')?.classList.remove("active");
    modal.querySelector('[data-step="net"]')?.classList.add("active");
    const title = modal.querySelector("#checkout-title");
    if (title) title.textContent = "Sending to the network…";
    let fulfill = null;
    try {
      if (state.order?.id) fulfill = await DataLogsAPI.fulfillOrder(state.order.id);
      if (fulfill?.order) {
        state.order = {
          ...fulfill.order,
          delivery_status: publicDeliveryStatus(fulfill.order.delivery_status),
        };
      }
    } catch {
      fulfill = { ok: false };
    }
    modal.querySelector('[data-step="net"]')?.classList.add("done");
    modal.querySelector('[data-step="net"]')?.classList.remove("active");
    modal.querySelector('[data-step="send"]')?.classList.add("active");
    await wait(400);
    modal.querySelector('[data-step="send"]')?.classList.add("done");
    state.fulfill = fulfill;
    window.dispatchEvent(new CustomEvent("datalogs:order-placed", { detail: state.order }));
    openStep("done");
  }

  function showPayError(message) {
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <h3 id="checkout-title">Could not complete payment</h3>
          <p class="error">${escapeHtml(message)}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <button class="btn btn-primary btn-full" type="button" data-back>Try again</button>
    `;
    wireClose();
    modal.querySelector("[data-back]").addEventListener("click", () => openStep("pay"));
  }

  function renderDone() {
    const order = state.order;
    const status = publicDeliveryStatus(order?.delivery_status);
    const completed = status === "completed";
    const title = completed ? "Data sent" : "Order placed";
    const hint = completed
      ? `${state.pkg.gb} GB is on its way to ${state.number} on ${networkName()}.`
      : `${state.pkg.gb} GB for ${state.number} on ${networkName()} is processing.`;
    modal.innerHTML = `
      <div class="success-mark" aria-hidden="true">${completed ? "✓" : "•"}</div>
      <h3 id="checkout-title">${title}</h3>
      <p class="hint">${hint}</p>
      <div class="receipt">
        <div><span>Order</span><strong>${order.order_code}</strong></div>
        <div><span>Network</span><strong>${networkName()}</strong></div>
        <div><span>Package</span><strong>${state.pkg.gb} GB</strong></div>
        <div><span>Paid</span><strong>${formatCedi(order.amount_paid)}</strong></div>
        <div><span>Status</span><strong>${publicDeliveryLabel(order.delivery_status)}</strong></div>
        <div><span>Method</span><strong>${
          state.method === "wallet" ? "Wallet" : state.method === "momo" ? "Mobile Money" : "Card"
        }</strong></div>
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
