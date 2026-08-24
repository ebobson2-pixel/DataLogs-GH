(async function activateAgent() {
  const profile = await DataLogsAPI.requireProfile(["agent", "admin"], "auth.html");
  if (!profile) return;
  if (profile.role === "admin") {
    window.location.href = "../admin/dashboard.html";
    return;
  }

  const state = {
    fee: 0,
    method: "momo",
    provider: "mtn",
    reference: null,
    challenge: null,
  };
  let swapTimer = 0;
  const backdrop = document.getElementById("activate-modal");
  const popup = document.getElementById("activate-popup");

  document.getElementById("activate-email").value = profile.email || profile.authEmail || "";
  document.getElementById("activate-signout").addEventListener("click", async () => {
    await DataLogsAPI.signOut();
    window.location.href = "auth.html";
  });

  const access = await DataLogsAPI.syncAgentActivation();
  if (!access.required || access.activated) {
    window.location.href = "dashboard.html";
    return;
  }

  state.fee = Number(access.fee || 0);
  document.getElementById("activate-lede").textContent =
    `Pay ${formatCedi(state.fee)} once. Your dashboard unlocks only after Paystack confirms the payment.`;
  document.getElementById("activate-form-wrap").hidden = false;
  document.getElementById("activate-submit").textContent = `Pay ${formatCedi(state.fee)} to activate`;

  document.getElementById("activate-methods").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-activate-method]");
    if (!btn) return;
    state.method = btn.dataset.activateMethod;
    document.querySelectorAll("#activate-methods .pay-method").forEach((el) => el.classList.toggle("selected", el === btn));
    document.getElementById("activate-momo-fields").hidden = state.method !== "momo";
    document.getElementById("activate-card-fields").hidden = state.method !== "card";
  });

  document.getElementById("activate-nets").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-activate-provider]");
    if (!btn) return;
    state.provider = btn.dataset.activateProvider;
    document.querySelectorAll("#activate-nets .pay-net").forEach((el) => el.classList.toggle("selected", el === btn));
  });

  function openBackdrop() {
    backdrop.classList.add("open");
    backdrop.classList.remove("closing");
    document.body.classList.add("pay-open");
  }

  function closePopup() {
    if (!backdrop.classList.contains("open")) return;
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.classList.remove("open", "closing");
      document.body.classList.remove("pay-open");
      popup.innerHTML = "";
    }, 240);
  }

  function swapPopup(paint) {
    clearTimeout(swapTimer);
    const already = popup.innerHTML.trim() !== "";
    if (!already) {
      paint();
      popup.classList.add("pay-swap-in");
      openBackdrop();
      return;
    }
    popup.classList.remove("pay-swap-in");
    popup.classList.add("pay-swap-out");
    swapTimer = setTimeout(() => {
      popup.classList.remove("pay-swap-out");
      paint();
      popup.classList.add("pay-swap-in");
    }, 150);
  }

  function waitHtml(title, hint) {
    return `
      <div class="modal-top">
        <div>
          <div class="pill">Activation payment</div>
          <h3>${title}</h3>
          <p class="hint" id="activate-popup-hint">${hint}</p>
        </div>
      </div>
      <div class="pay-wait" aria-hidden="true"><i></i><i></i><i></i><div class="pay-wait-phone">✓</div></div>
      <p class="hint" style="text-align:center">Stay here until Paystack confirms the payment.</p>
    `;
  }

  function showChallenge() {
    const result = state.challenge;
    const kind = result.next;
    const label = kind === "pin" ? "Card PIN" : kind === "otp" ? "Enter OTP" : "Phone number";
    const placeholder = kind === "pin" ? "PIN" : kind === "otp" ? "6-digit code" : "Phone number";
    const maxLen = kind === "otp" ? 6 : kind === "pin" ? 4 : 15;
    const pattern = kind === "otp" ? "[0-9]{6}" : kind === "pin" ? "[0-9]{4}" : "[0-9+ ]{8,15}";
    swapPopup(() => {
      popup.innerHTML = `
        <div class="pay-otp pay-fields-in">
          <div class="pay-wait" aria-hidden="true"><i></i><i></i><i></i><div class="pay-wait-phone">${kind === "pin" ? "🔒" : "🔑"}</div></div>
          <div class="pill">Almost there</div>
          <h3>${label}</h3>
          <p class="hint">${escapeHtml(result.display_text || "Confirm this charge to continue.")}</p>
          <form class="form" id="activate-challenge-form">
            <input class="pay-otp-input" id="activate-challenge-input" required autocomplete="one-time-code" inputmode="numeric" maxlength="${maxLen}" pattern="${pattern}" placeholder="${escapeHtml(placeholder)}">
            <p class="error" id="activate-sheet-error" hidden></p>
            <button class="btn btn-primary btn-full" type="submit">Confirm payment</button>
          </form>
        </div>
      `;
      const input = popup.querySelector("#activate-challenge-input");
      input.addEventListener("input", () => {
        input.value = String(input.value || "").replace(/\D/g, "").slice(0, maxLen);
      });
      input.focus();
      popup.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = popup.querySelector("#activate-sheet-error");
        error.hidden = true;
        try {
          const next =
            kind === "pin"
              ? await DataLogsPay.submitPin(result.reference, input.value)
              : kind === "phone"
                ? await DataLogsPay.submitPhone(result.reference, input.value)
                : await DataLogsPay.submitOtp(result.reference, input.value);
          await handleNext(next);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message || "Could not continue.";
        }
      });
    });
  }

  async function waitForPaid(reference) {
    const started = Date.now();
    while (Date.now() - started < 180000) {
      const status = await DataLogsPay.status(reference);
      if (status.status === "success") {
        const accessNow = await DataLogsAPI.syncAgentActivation();
        if (accessNow.activated || !accessNow.required) {
          swapPopup(() => {
            popup.innerHTML = `
              <div class="success-mark" aria-hidden="true">✓</div>
              <h3>Agent activated</h3>
              <p class="hint">Your dashboard is unlocked.</p>
              <button class="btn btn-primary btn-full" type="button" id="activate-done">Open dashboard</button>
            `;
            popup.querySelector("#activate-done").addEventListener("click", () => {
              window.location.href = "dashboard.html";
            });
          });
          setTimeout(() => {
            window.location.href = "dashboard.html";
          }, 1200);
          return;
        }
      }
      if (status.status === "failed" || status.status === "abandoned") {
        throw new Error("Payment was not completed.");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("Still waiting for Paystack. Keep this page open and try again in a minute.");
  }

  async function handleNext(result) {
    if (result.url) window.open(String(result.url), "_blank", "noopener");
    if (result.next === "success") {
      swapPopup(() => {
        popup.innerHTML = waitHtml("Payment confirmed", "Unlocking your agent dashboard…");
      });
      await waitForPaid(result.reference);
      return;
    }
    if (result.next === "failed") throw new Error(result.display_text || "Payment failed.");
    if (result.next === "otp" || result.next === "pin" || result.next === "phone") {
      state.challenge = result;
      showChallenge();
      return;
    }
    swapPopup(() => {
      popup.innerHTML = waitHtml("Approve on your phone", result.display_text || "Approve the payment, then wait here.");
    });
    await waitForPaid(result.reference);
  }

  document.getElementById("activate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("activate-error");
    const submit = document.getElementById("activate-submit");
    error.hidden = true;
    try {
      if (!window.DataLogsPay) throw new Error("Payment is not loaded. Refresh and try again.");
      const email = document.getElementById("activate-email").value.trim();
      const momoPhone = document.getElementById("activate-momo-phone").value.trim();
      const card = {
        number: document.getElementById("activate-card-number").value,
        month: document.getElementById("activate-card-month").value,
        year: document.getElementById("activate-card-year").value,
        cvv: document.getElementById("activate-card-cvv").value,
      };
      if (state.method === "momo" && !momoPhone.replace(/\D/g, "")) {
        throw new Error("Enter the Mobile Money number that will pay.");
      }
      if (state.method === "card" && String(card.number).replace(/\D/g, "").length < 13) {
        throw new Error("Enter a valid card number.");
      }
      submit.disabled = true;
      swapPopup(() => {
        popup.innerHTML = waitHtml("Confirming payment…", "Stay on this page while Paystack confirms activation.");
      });
      const charged = await DataLogsPay.charge({
        kind: "agent_activation",
        channel: state.method,
        email,
        momo: { phone: momoPhone, provider: state.provider },
        card: {
          number: card.number,
          cvv: card.cvv,
          expiry_month: card.month,
          expiry_year: card.year,
        },
      });
      state.reference = charged.reference;
      await handleNext(charged);
    } catch (err) {
      closePopup();
      error.hidden = false;
      error.textContent = err.message || "Could not start activation payment.";
    } finally {
      submit.disabled = false;
    }
  });

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closePopup();
  });
})();
