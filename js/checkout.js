(function checkout() {
  const root = document.getElementById("checkout-root");
  if (!root) return;

  const state = {
    pkg: null,
    number: "",
    recipientMode: "other",
    method: "momo",
    tier: "retail",
    storeId: null,
    order: null,
    fulfill: null,
    saveBeneficiary: false,
    beneficiaryLabel: "",
  };

  document.addEventListener("datalogs:buy-again", (event) => {
    const detail = event.detail || {};
    const pkg = getPackage(detail.packageId);
    if (!pkg) return;
    state.pkg = { ...pkg };
    state.tier = detail.tier === "agent" ? "agent" : "retail";
    if (state.tier === "agent") state.pkg.price = pkg.agentPrice;
    state.storeId = detail.storeId || window.__STORE_ID || null;
    state.number = detail.recipient || "";
    state.recipientMode = state.number ? "other" : "self";
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

  root.innerHTML = `
    <div class="modal-backdrop" id="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <div class="modal pay-popup"></div>
    </div>
  `;

  const backdrop = root.querySelector("#checkout-modal");
  const modal = root.querySelector(".modal");
  let swapTimer = 0;

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
    state.recipientMode = window.DataLogsCustomer?.getMyPhone?.() ? "self" : "other";
    state.saveBeneficiary = false;
    state.beneficiaryLabel = "";
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
    document.body.classList.add("pay-open");
    const paint = () => {
      if (step === "number") renderNumber();
      if (step === "method") renderMethod();
      if (step === "pay") renderPay();
      if (step === "process") renderProcess();
      if (step === "challenge") renderChallenge();
      if (step === "done") renderDone();
    };
    swapModal(paint);
  }

  function swapModal(paint) {
    clearTimeout(swapTimer);
    const alreadyOpen = modal.innerHTML.trim() !== "";
    if (!alreadyOpen) {
      paint();
      modal.classList.add("pay-swap-in");
      return;
    }
    modal.classList.remove("pay-swap-in");
    modal.classList.add("pay-swap-out");
    swapTimer = setTimeout(() => {
      modal.classList.remove("pay-swap-out");
      paint();
      modal.classList.add("pay-swap-in");
    }, 150);
  }

  function closeModal() {
    if (!backdrop.classList.contains("open")) return;
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.remove("open", "closing");
      document.body.classList.remove("pay-open");
      modal.innerHTML = "";
    }, 240);
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
    const beneficiaries = window.DataLogsCustomer?.getBeneficiaries?.(state.pkg.network) || [];
    const myPhone = window.DataLogsCustomer?.getMyPhone?.() || "";
    const benOptions = beneficiaries
      .map(
        (b) =>
          `<button class="ben-chip" type="button" data-ben="${b.id}">${escapeHtml(b.label)} · ${escapeHtml(b.phone)}</button>`
      )
      .join("");
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">${state.tier === "agent" ? "Agent wholesale · " : ""}${networkName()} · ${state.pkg.gb} GB</div>
          <h3 id="checkout-title">Who should receive this bundle?</h3>
          <p class="hint">${priceHint()}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <form class="form pay-fields-in" id="number-form">
        <div class="recipient-mode" role="group" aria-label="Recipient type">
          <button class="recipient-mode-btn ${state.recipientMode === "self" ? "active" : ""}" type="button" data-recipient-mode="self">Myself</button>
          <button class="recipient-mode-btn ${state.recipientMode === "other" ? "active" : ""}" type="button" data-recipient-mode="other">Someone else</button>
        </div>
        ${beneficiaries.length ? `<div class="ben-list"><p class="hint">Saved numbers</p><div class="ben-chips">${benOptions}</div></div>` : ""}
        <label>
          Recipient number
          <input id="recipient" inputmode="tel" autocomplete="tel" placeholder="${state.recipientMode === "self" ? "Your " + networkName() + " number" : "024 123 4567"}" value="${escapeHtml(state.number || (state.recipientMode === "self" ? myPhone : ""))}" required>
        </label>
        <p class="hint">Use a Ghana ${networkName()} number. Prefixes: ${prefixes}</p>
        <div class="recipient-confirm" id="recipient-confirm" hidden>
          <span>Confirm recipient</span>
          <strong id="recipient-confirm-value"></strong>
        </div>
        ${state.recipientMode === "other" ? `<label class="save-ben-check"><input type="checkbox" id="save-ben"> Save this number for next time</label>` : ""}
        ${state.recipientMode === "other" ? `<label id="ben-label-wrap" hidden>Label <input id="ben-label" type="text" placeholder="Mum, Shop line…"></label>` : ""}
        <p class="error" id="number-error" hidden></p>
        <button class="btn btn-primary btn-full" type="submit">Continue to payment</button>
      </form>
    `;
    wireClose();
    const recipientInput = modal.querySelector("#recipient");
    const confirmBox = modal.querySelector("#recipient-confirm");
    const confirmValue = modal.querySelector("#recipient-confirm-value");
    const saveBen = modal.querySelector("#save-ben");
    const benLabelWrap = modal.querySelector("#ben-label-wrap");

    function paintConfirm() {
      const val = recipientInput.value.trim();
      if (!val) {
        confirmBox.hidden = true;
        return;
      }
      confirmBox.hidden = false;
      confirmValue.textContent = val;
    }
    recipientInput.addEventListener("input", paintConfirm);
    paintConfirm();

    modal.querySelectorAll("[data-recipient-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.recipientMode = btn.dataset.recipientMode;
        if (state.recipientMode === "self" && myPhone) recipientInput.value = myPhone;
        openStep("number");
      });
    });

    modal.querySelectorAll("[data-ben]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ben = beneficiaries.find((b) => b.id === btn.dataset.ben);
        if (!ben) return;
        recipientInput.value = ben.phone;
        state.recipientMode = "other";
        paintConfirm();
      });
    });

    saveBen?.addEventListener("change", () => {
      if (benLabelWrap) benLabelWrap.hidden = !saveBen.checked;
    });

    modal.querySelector("#number-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = recipientInput.value;
      const result = validateGhanaNumber(raw, state.pkg.network);
      const error = modal.querySelector("#number-error");
      if (!result.ok) {
        error.hidden = false;
        error.textContent = result.message;
        return;
      }
      state.number = result.pretty;
      if (state.recipientMode === "self") window.DataLogsCustomer?.setMyPhone?.(state.number);
      state.saveBeneficiary = !!saveBen?.checked;
      state.beneficiaryLabel = modal.querySelector("#ben-label")?.value?.trim() || "";
      openStep("method");
    });
  }

  function packageBasePrice() {
    return Number(state.pkg?.price) || 0;
  }

  function payTotals(includeFee) {
    const base = packageBasePrice();
    if (!includeFee) {
      return { base, fee: 0, total: base };
    }
    const fee = paystackFeeAmount(base);
    return { base, fee, total: totalWithPaystackFee(base) };
  }

  function payBreakdownHtml(includeFee) {
    const { base, fee, total } = payTotals(includeFee);
    if (!includeFee) {
      return `<p class="hint">${formatCedi(base)} · ${state.pkg.gb} GB to ${state.number}</p>`;
    }
    return `
      <div class="pay-breakdown" aria-label="Payment breakdown">
        <div><span>Package</span><strong>${formatCedi(base)}</strong></div>
        <div><span>Paystack fee (3%)</span><strong>${formatCedi(fee)}</strong></div>
        <div class="pay-breakdown-total"><span>Total</span><strong>${formatCedi(total)}</strong></div>
      </div>
    `;
  }

  function renderMethod() {
    const wallet =
      state.tier === "agent"
        ? choiceCard("wallet", "₵", "Pay from wallet", "Use your DataLogs GH balance")
        : "";
    const base = packageBasePrice();
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">Choose a way to pay</div>
          <h3 id="checkout-title">How do you want to pay?</h3>
          <p class="hint">${formatCedi(base)} · ${state.pkg.gb} GB to ${state.number}</p>
          <p class="hint">MoMo and card payments include a 3% Paystack fee.</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="pay-choice">
        ${choiceCard("momo", "📱", "Mobile Money", "MTN, Telecel Cash or AT Money")}
        ${choiceCard("card", "💳", "Debit or credit card", "Visa or Mastercard")}
        ${wallet}
      </div>
      <button class="btn btn-ghost btn-full" type="button" data-back>Back</button>
    `;
    wireClose();
    modal.querySelector("[data-back]").addEventListener("click", () => openStep("number"));
    modal.querySelectorAll("[data-method]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const networkCheck = validateGhanaNumber(state.number, state.pkg.network);
        if (!networkCheck.ok) {
          openStep("number");
          return;
        }
        state.number = networkCheck.pretty;
        state.method = btn.dataset.method;
        btn.classList.add("picked");
        setTimeout(() => openStep("pay"), 180);
      });
    });
  }

  function choiceCard(id, icon, title, subtitle) {
    return `
      <button class="pay-choice-card" type="button" data-method="${id}">
        <span class="pay-choice-ico" aria-hidden="true">${icon}</span>
        <span>
          <strong>${title}</strong>
          <span class="hint">${subtitle}</span>
        </span>
      </button>
    `;
  }

  function renderPay() {
    const useFee = state.method !== "wallet";
    const { total } = payTotals(useFee);
    modal.innerHTML = `
      <div class="modal-top">
        <div>
          <div class="pill">${state.method === "wallet" ? "Wallet" : state.method === "card" ? "Card" : "Mobile Money"}</div>
          <h3 id="checkout-title">Pay ${formatCedi(total)}</h3>
          ${payBreakdownHtml(useFee)}
          <p class="hint">Sending ${state.pkg.gb} GB to ${state.number} on ${networkName()}</p>
        </div>
        <button class="close-btn" type="button" data-close aria-label="Close">×</button>
      </div>
      <form class="form pay-form pay-fields-in" id="pay-form">
        ${state.method === "wallet" ? walletFields() : payFields()}
        <p class="error" id="pay-error" hidden></p>
        <div class="hero-actions" style="margin-top:12px">
          <button class="btn btn-ghost" type="button" data-back>Back</button>
          <button class="btn btn-primary btn-full" type="submit">${
            state.method === "wallet" ? "Pay from wallet" : `Pay ${formatCedi(total)}`
          }</button>
        </div>
      </form>
    `;
    wireClose();
    preloadPayDefaults();
    wireNetTiles();
    modal.querySelector("[data-back]").addEventListener("click", () => openStep("method"));
    modal.querySelector("#pay-form").addEventListener("submit", (event) => {
      event.preventDefault();
      collectPayForm();
      openStep("process");
    });
  }

  function wireNetTiles() {
    modal.querySelectorAll("[data-provider]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.momoProvider = btn.dataset.provider;
        modal.querySelectorAll("[data-provider]").forEach((el) => el.classList.toggle("selected", el === btn));
      });
    });
  }

  function netTiles() {
    const nets = [
      { id: "mtn", name: "MTN MoMo", mark: "MTN" },
      { id: "telecel", name: "Telecel", mark: "TEL" },
      { id: "airteltigo", name: "AT Money", mark: "AT" },
    ];
    return `
      <p class="hint" style="margin:0 0 6px">Pay with</p>
      <div class="pay-nets" role="list">
        ${nets
          .map(
            (n) => `
          <button class="pay-net ${n.id} ${state.momoProvider === n.id ? "selected" : ""}" type="button" data-provider="${n.id}">
            <span class="pay-net-mark">${n.mark}</span>
            <strong>${n.name}</strong>
          </button>`
          )
          .join("")}
      </div>
    `;
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
      ${netTiles()}
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
    const selectedNet = modal.querySelector(".pay-net.selected");
    if (selectedNet) state.momoProvider = selectedNet.dataset.provider;
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

  function waitVisual(title, hint) {
    return `
      <div class="modal-top">
        <div>
          <div class="pill">Secure payment</div>
          <h3 id="checkout-title">${title}</h3>
          <p class="hint" id="pay-hint">${hint}</p>
        </div>
      </div>
      <div class="pay-wait" aria-hidden="true">
        <i></i><i></i><i></i>
        <div class="pay-wait-phone">📱</div>
      </div>
      <ul class="progress-list">
        <li class="active" data-step="pay"><span class="dot"></span> Taking payment</li>
        <li data-step="net"><span class="dot"></span> Sending ${networkName()} to the provider</li>
        <li data-step="send"><span class="dot"></span> Confirming ${state.pkg.gb} GB to ${state.number}</li>
      </ul>
    `;
  }

  function renderChallenge() {
    const result = state.challenge;
    const kind = result.next;
    const label = kind === "pin" ? "Card PIN" : kind === "otp" ? "Enter OTP" : "Phone number";
    const placeholder = kind === "pin" ? "PIN" : kind === "otp" ? "6-digit code" : "Phone number";
    const maxLen = kind === "otp" ? 6 : kind === "pin" ? 4 : 15;
    const pattern = kind === "otp" ? "[0-9]{6}" : kind === "pin" ? "[0-9]{4}" : "[0-9+ ]{8,15}";
    modal.innerHTML = `
      <div class="pay-otp pay-fields-in">
        <div class="pay-wait" aria-hidden="true"><i></i><i></i><i></i><div class="pay-wait-phone">${kind === "pin" ? "🔒" : "🔑"}</div></div>
        <div class="pill">Almost there</div>
        <h3 id="checkout-title">${escapeHtml(label)}</h3>
        <p class="hint">${escapeHtml(result.display_text || "Confirm this charge to continue.")}</p>
        <form class="form" id="pay-challenge">
          <input class="pay-otp-input" id="challenge-input" required autocomplete="one-time-code" inputmode="numeric" maxlength="${maxLen}" pattern="${pattern}" placeholder="${escapeHtml(placeholder)}">
          <p class="error" id="challenge-error" hidden></p>
          <button class="btn btn-primary btn-full" type="submit">Confirm payment</button>
        </form>
      </div>
    `;
    const input = modal.querySelector("#challenge-input");
    input.addEventListener("input", () => {
      input.value = String(input.value || "").replace(/\D/g, "").slice(0, maxLen);
    });
    input.focus();
    modal.querySelector("#pay-challenge").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = modal.querySelector("#challenge-error");
      error.hidden = true;
      try {
        const next =
          kind === "pin"
            ? await DataLogsPay.submitPin(state.reference, input.value)
            : kind === "phone"
              ? await DataLogsPay.submitPhone(state.reference, input.value)
              : await DataLogsPay.submitOtp(state.reference, input.value);
        await handlePaystackNext(next);
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || "Could not continue.";
      }
    });
  }

  async function renderProcess() {
    const networkCheck = validateGhanaNumber(state.number, state.pkg.network);
    if (!networkCheck.ok) {
      modal.innerHTML = `
        <div class="pay-fields-in">
          <div class="pill">${escapeHtml(networkName())} ${state.pkg.gb} GB</div>
          <h3 id="checkout-title">Wrong network number</h3>
          <p class="error">${escapeHtml(networkCheck.message)}</p>
          <p class="hint">Payment was blocked. Enter a ${escapeHtml(networkName())} number for this package.</p>
          <button class="btn btn-primary btn-full" type="button" data-fix-number>Edit recipient number</button>
        </div>`;
      modal.querySelector("[data-fix-number]")?.addEventListener("click", () => openStep("number"));
      return;
    }
    state.number = networkCheck.pretty;

    modal.innerHTML = waitVisual("Confirming payment…", "Stay on this page. We wait for Paystack to confirm before sending data.");
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
    if (result.next === "success") {
      if (!modal.querySelector('[data-step="pay"]')) {
        modal.innerHTML = waitVisual("Payment confirmed", "Finishing your order…");
      }
      await waitForPaidOrder(result);
      return;
    }
    if (result.next === "failed") throw new Error(result.display_text || "Payment failed.");
    if (result.url) window.open(String(result.url), "_blank", "noopener");

    if (result.next === "otp" || result.next === "pin" || result.next === "phone") {
      state.challenge = result;
      openStep("challenge");
      return;
    }

    modal.innerHTML = waitVisual(
      result.next === "offline" ? "Approve on your phone" : "Confirming payment…",
      result.display_text || "Complete the payment on your phone."
    );
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
      await wait(1000);
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
    modal.querySelector('[data-step="send"]')?.classList.add("done");
    state.fulfill = fulfill;
    window.DataLogsCustomer?.saveRecentOrder?.(state.order, state.pkg, {
      recipient: state.number,
      tier: state.tier,
      storeId: state.storeId,
      method: state.method,
    });
    if (state.saveBeneficiary && state.recipientMode === "other") {
      window.DataLogsCustomer?.saveBeneficiary?.({
        label: state.beneficiaryLabel || `${networkName()} line`,
        phone: state.number,
        network: state.pkg.network,
      });
    }
    window.dispatchEvent(new CustomEvent("datalogs:order-placed", { detail: state.order }));
    openStep("done");
  }

  function showPayError(message) {
    modal.classList.remove("pay-swap-out");
    modal.classList.add("pay-swap-in");
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
    const failed = status === "failed" || String(order?.delivery_status).toLowerCase() === "failed";
    const completed = status === "completed";
    const title = failed ? "Delivery issue" : completed ? "Data sent successfully!" : "Order placed";
    const hint = failed
      ? `We could not deliver ${state.pkg.gb} GB to ${state.number} yet. Track the order or contact support.`
      : completed
        ? `${state.pkg.gb} GB is on its way to ${state.number} on ${networkName()}.`
        : `${state.pkg.gb} GB for ${state.number} on ${networkName()} is processing.`;
    const receiptData = {
      orderCode: order.order_code,
      network: state.pkg.network,
      networkName: networkName(),
      gb: state.pkg.gb,
      recipient: state.number,
      amount: order.amount_paid,
      method: state.method === "wallet" ? "Wallet" : state.method === "momo" ? "Mobile Money" : "Card",
      status: order.delivery_status,
      createdAt: order.created_at,
    };
    modal.innerHTML = `
      <div class="success-mark ${failed ? "is-warn" : ""}" aria-hidden="true">${failed ? "!" : completed ? "✓" : "•"}</div>
      <h3 id="checkout-title">${title}</h3>
      <p class="hint">${hint}</p>
      <div class="receipt">
        <div><span>Transaction ID</span><strong>${order.order_code}</strong></div>
        <div><span>Network</span><strong>${networkName()}</strong></div>
        <div><span>Bundle</span><strong>${state.pkg.gb} GB</strong></div>
        <div><span>Recipient</span><strong>${state.number}</strong></div>
        <div><span>Package</span><strong>${formatCedi(packageBasePrice())}</strong></div>
        ${
          state.method !== "wallet"
            ? `<div><span>Paystack fee (3%)</span><strong>${formatCedi(paystackFeeAmount(packageBasePrice()))}</strong></div>`
            : ""
        }
        <div><span>Total paid</span><strong>${formatCedi(order.amount_paid)}</strong></div>
        <div><span>Status</span><strong>${publicDeliveryLabel(order.delivery_status)}</strong></div>
        <div><span>Method</span><strong>${receiptData.method}</strong></div>
      </div>
      <div class="hero-actions" style="margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-primary" type="button" data-buy-again>Buy again</button>
        <button class="btn btn-ghost" type="button" data-track-order>Track</button>
        <button class="btn btn-ghost" type="button" data-receipt-dl>Receipt</button>
        <button class="btn btn-ghost" type="button" data-receipt-share>Share</button>
        ${failed || !completed ? `<a class="btn btn-ghost" href="customer/refunds.html?order=${encodeURIComponent(order.order_code)}">Get help</a>` : ""}
      </div>
      <button class="btn btn-ghost btn-full" type="button" data-close style="margin-top:8px">Done</button>
    `;
    wireClose();
    modal.querySelector("[data-buy-again]")?.addEventListener("click", () => {
      closeModal();
      window.DataLogsCustomer?.buyAgain?.({
        packageId: state.pkg.id,
        recipient: state.number,
        tier: state.tier,
        storeId: state.storeId,
      });
    });
    modal.querySelector("[data-track-order]")?.addEventListener("click", () => {
      closeModal();
      if (window.DataLogsTrack?.openWithCode) window.DataLogsTrack.openWithCode(order.order_code);
      else window.DataLogsTrack?.open?.();
    });
    modal.querySelector("[data-receipt-dl]")?.addEventListener("click", () => {
      window.DataLogsReceipt?.downloadReceipt?.(receiptData);
    });
    modal.querySelector("[data-receipt-share]")?.addEventListener("click", () => {
      window.DataLogsReceipt?.shareReceipt?.(receiptData);
    });
  }

  function wireClose() {
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", closeModal));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
