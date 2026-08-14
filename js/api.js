const DataLogsAPI = (() => {
  const client = window.supabase.createClient(
    window.DATALOGS_CONFIG.supabaseUrl,
    window.DATALOGS_CONFIG.supabaseAnonKey
  );

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session;
  }

  async function getUser() {
    const session = await getSession();
    return session?.user || null;
  }

  async function getProfile() {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { ...data, authEmail: user.email };
  }

  async function requireProfile(roles, loginUrl) {
    const session = await getSession();
    if (!session) {
      window.location.href = loginUrl;
      return null;
    }
    const profile = await getProfile();
    if (!profile) {
      window.location.href = loginUrl;
      return null;
    }
    if (profile.blocked) {
      await signOut();
      const blockedUrl = loginUrl.includes("?") ? `${loginUrl}&blocked=1` : `${loginUrl}?blocked=1`;
      window.location.href = blockedUrl;
      return null;
    }
    if (roles && !roles.includes(profile.role)) {
      window.location.href = loginUrl;
      return null;
    }
    return profile;
  }

  async function syncAgentActivation() {
    const { data, error } = await client.rpc("sync_agent_activation");
    if (error) throw error;
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    return payload || { ok: true, required: false, activated: true, fee: 0 };
  }

  async function routeAgentAfterAuth() {
    const profile = await getProfile();
    if (!profile) return "auth.html";
    if (profile.role === "admin") return "../admin/dashboard.html";
    if (profile.role !== "agent") return "auth.html";
    try {
      const access = await syncAgentActivation();
      if (access.required && !access.activated) return "activate.html";
    } catch {
      /* if sync fails, try dashboard and let it re-check */
    }
    return "dashboard.html";
  }

  async function signUp({ name, email, phone, password, role }) {
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: name.trim(),
          phone: phone.trim(),
          role: role === "agent" ? "agent" : "customer",
        },
      },
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, data };
  }

  async function signIn({ email, password }) {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) return { ok: false, message: error.message };
    try {
      const profile = await getProfile();
      if (profile?.blocked) {
        await client.auth.signOut();
        return { ok: false, message: "This account has been blocked. Contact DataLogs GH support." };
      }
    } catch {
      /* continue */
    }
    return { ok: true, data };
  }

  async function signOut() {
    await client.auth.signOut();
  }

  async function fetchPackages({ includeInactive = false, applyCustomPrices } = {}) {
    let query = client.from("packages").select("*").order("sort_order", { ascending: true });
    if (!includeInactive) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const useCustom = applyCustomPrices ?? !includeInactive;
    let customMap = new Map();
    if (useCustom) {
      try {
        const user = await getUser();
        if (user) {
          const { data: custom } = await client
            .from("user_custom_prices")
            .select("package_id, agent_price")
            .eq("user_id", user.id);
          customMap = new Map((custom || []).map((row) => [row.package_id, Number(row.agent_price)]));
        }
      } catch {
        /* guests have no custom prices */
      }
    }
    return rows.map((row) => {
      const mapped = mapPackage(row);
      if (customMap.has(row.id)) {
        mapped.agentPrice = customMap.get(row.id);
        mapped.customPriced = true;
      }
      return mapped;
    });
  }

  async function upsertPackage(payload) {
    const row = {
      network: payload.network,
      gb: Number(payload.gb),
      retail_price: Number(payload.retail_price),
      agent_price: Number(payload.agent_price),
      validity: payload.validity || "Non expiry",
      tag: payload.tag || null,
      active: payload.active !== false,
      sort_order: Number(payload.sort_order || 0),
    };
    if (payload.id) row.id = payload.id;
    const { data, error } = await client.from("packages").upsert(row).select().single();
    if (error) throw error;
    return mapPackage(data);
  }

  async function deletePackage(id) {
    const { error } = await client.from("packages").delete().eq("id", id);
    if (error) throw error;
  }

  async function getStoreByAgent(agentId) {
    const { data, error } = await client.from("agent_stores").select("*").eq("agent_id", agentId).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getStoreBySlug(slug) {
    const { data, error } = await client
      .from("agent_stores")
      .select("*, profiles:agent_id(full_name, phone)")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function saveStore(agentId, payload) {
    let slug = slugify(payload.slug || payload.name);
    if (!slug) throw new Error("Give your store a name first.");

    const existing = await getStoreByAgent(agentId);
    const row = {
      agent_id: agentId,
      name: payload.name.trim(),
      slug,
      tagline: (payload.tagline || "").trim(),
      networks: payload.networks,
      published: payload.published !== false,
    };

    if (existing) {
      const { data, error } = await client
        .from("agent_stores")
        .update(row)
        .eq("agent_id", agentId)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await client.from("agent_stores").insert(row).select().single();
    if (error) {
      if (String(error.message).includes("duplicate") || error.code === "23505") {
        row.slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
        const retry = await client.from("agent_stores").insert(row).select().single();
        if (retry.error) throw retry.error;
        return retry.data;
      }
      throw error;
    }
    return data;
  }

  async function placeOrder({ packageId, recipientNumber, paymentMethod, pricingTier, agentStoreId }) {
    const { data, error } = await client.rpc("place_order", {
      p_package_id: packageId,
      p_recipient_number: recipientNumber,
      p_payment_method: paymentMethod,
      p_pricing_tier: pricingTier || "retail",
      p_agent_store_id: agentStoreId || null,
    });
    if (error) throw error;
    return data;
  }

  async function placeOrderWithWallet({ packageId, recipientNumber }) {
    const { data, error } = await client.rpc("place_order_with_wallet", {
      p_package_id: packageId,
      p_recipient_number: recipientNumber,
    });
    if (error) throw error;
    return data;
  }

  async function fulfillOrder(orderId, { retry = false } = {}) {
    const { data, error } = await client.functions.invoke("fulfill-order", {
      body: { action: retry ? "retry" : "fulfill", orderId },
    });
    if (data && typeof data === "object") return data;
    if (error) throw error;
    return data;
  }

  async function providerBalance() {
    const invoke = client.functions.invoke("fulfill-order", {
      body: { action: "balance" },
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Provider balance timed out")), 8000);
    });
    const { data, error } = await Promise.race([invoke, timeout]);
    if (data && typeof data === "object") return data;
    if (error) throw error;
    return data;
  }

  function publicDeliveryStatus(status) {
    return status === "delivered" || status === "completed" ? "completed" : "processing";
  }

  function maskPublicOrder(order) {
    if (!order) return order;
    return {
      ...order,
      delivery_status: publicDeliveryStatus(order.delivery_status),
      fail_reason: null,
      provider_error: null,
      provider_status: null,
      retryable: false,
    };
  }

  async function myOrders() {
    const { data, error } = await client
      .from("orders")
      .select("*, agent_stores(name, slug)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(maskPublicOrder);
  }

  async function allOrders() {
    const { data, error } = await client
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(400);
    if (error) throw error;
    return data || [];
  }

  async function updateOrder(id, patch) {
    const { data, error } = await client.from("orders").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function allUsers() {
    const { data, error } = await client
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function updateUserRole(id, role) {
    const { data, error } = await client.from("profiles").update({ role }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function allStores() {
    const { data, error } = await client
      .from("agent_stores")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function adminDashboardData() {
    const { data, error } = await client.rpc("admin_dashboard_data");
    if (error) throw error;
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    return payload || { users: [], packages: [], orders: [], stores: [] };
  }

  async function getWallet(agentId) {
    const id = agentId || (await getProfile())?.id;
    if (!id) return null;
    const { data, error } = await client.from("wallets").select("*").eq("agent_id", id).maybeSingle();
    if (error) throw error;
    return data || { agent_id: id, balance: 0 };
  }

  async function getWalletTransactions(agentId) {
    let query = client.from("wallet_transactions").select("*").order("created_at", { ascending: false }).limit(80);
    if (agentId) query = query.eq("agent_id", agentId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getWithdrawals() {
    const { data, error } = await client
      .from("withdrawals")
      .select("*, profiles:agent_id(full_name, email)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function requestWithdrawal({ amount, momoNumber, accountName, network }) {
    const { data, error } = await client.rpc("request_withdrawal", {
      p_amount: Number(amount),
      p_momo_number: momoNumber,
      p_account_name: accountName || null,
      p_network: network,
      p_method: "momo",
    });
    if (error) throw error;
    return data;
  }

  async function reviewWithdrawal({ id, decision, note }) {
    const { data, error } = await client.rpc("review_withdrawal", {
      p_withdrawal_id: id,
      p_decision: decision,
      p_note: note || null,
    });
    if (error) throw error;
    return data;
  }

  async function getAgentStorePrices(agentId) {
    let query = client.from("agent_store_prices").select("*");
    if (agentId) query = query.eq("agent_id", agentId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function setAgentPackageProfit(packageId, profit) {
    const { data, error } = await client.rpc("set_agent_package_profit", {
      p_package_id: packageId,
      p_profit: Number(profit),
    });
    if (error) throw error;
    return data;
  }

  async function trackOrdersByPhone(phone) {
    const { data, error } = await client.rpc("track_orders_by_phone", {
      p_phone: phone,
    });
    if (error) throw error;
    return data || [];
  }

  async function getSiteSettings() {
    const { data, error } = await client.from("site_settings").select("*").eq("id", 1).maybeSingle();
    if (error) throw error;
    return data || { whatsapp_channel_url: "", support_contact: "", support_label: "Support" };
  }

  async function updateSiteSettings({
    whatsappChannelUrl,
    supportContact,
    supportLabel,
    withdrawalThreshold,
    agentActivationFeeEnabled,
    agentActivationFee,
  }) {
    const { data, error } = await client.rpc("update_site_settings", {
      p_whatsapp_channel_url: whatsappChannelUrl || "",
      p_support_contact: supportContact || "",
      p_support_label: supportLabel || "Support",
      p_withdrawal_threshold:
        withdrawalThreshold == null || withdrawalThreshold === "" ? null : Number(withdrawalThreshold),
      p_agent_activation_fee_enabled:
        agentActivationFeeEnabled == null ? null : !!agentActivationFeeEnabled,
      p_agent_activation_fee:
        agentActivationFee == null || agentActivationFee === "" ? null : Number(agentActivationFee),
    });
    if (error) throw error;
    return data;
  }

  async function adminCreditWallet(userId, amount, note) {
    const { data, error } = await client.rpc("admin_credit_wallet", {
      p_user_id: userId,
      p_amount: Number(amount),
      p_note: note || null,
    });
    if (error) throw error;
    return data;
  }

  async function adminSetBlocked(userId, blocked) {
    const { data, error } = await client.rpc("admin_set_blocked", {
      p_user_id: userId,
      p_blocked: !!blocked,
    });
    if (error) throw error;
    return data;
  }

  async function getUserCustomPrices(userId) {
    const { data, error } = await client.from("user_custom_prices").select("*").eq("user_id", userId);
    if (error) throw error;
    return data || [];
  }

  async function adminSetCustomPrice(userId, packageId, agentPrice) {
    const { data, error } = await client.rpc("admin_set_custom_price", {
      p_user_id: userId,
      p_package_id: packageId,
      p_agent_price: agentPrice == null || agentPrice === "" ? null : Number(agentPrice),
    });
    if (error) throw error;
    return data;
  }

  async function ordersForUser(userId) {
    const { data, error } = await client
      .from("orders")
      .select("*, agent_stores(name, slug)")
      .eq("buyer_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function listApiKeys() {
    const { data, error } = await client.rpc("list_agent_api_keys");
    if (error) throw error;
    return data || [];
  }

  async function createApiKey(name) {
    const { data, error } = await client.rpc("create_agent_api_key", { p_name: name || "Website" });
    if (error) throw error;
    return data;
  }

    async function revokeApiKey(id) {
    const { data, error } = await client.rpc("revoke_agent_api_key", { p_id: id });
    if (error) throw error;
    return data;
  }

  async function adminApiConsole() {
    const { data, error } = await client.rpc("admin_api_console");
    if (error) throw error;
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    return payload || { stats: {}, agents: [], keys: [], requests: [] };
  }

  async function adminCreateUserApiKey(userId, name) {
    const { data, error } = await client.rpc("admin_create_user_api_key", {
      p_user_id: userId,
      p_name: name || "Website",
    });
    if (error) throw error;
    return data;
  }

  async function adminRevokeApiKey(id) {
    const { data, error } = await client.rpc("admin_revoke_api_key", { p_id: id });
    if (error) throw error;
    return data;
  }

  async function adminSetApiDisabled(userId, disabled) {
    const { data, error } = await client.rpc("admin_set_api_disabled", {
      p_user_id: userId,
      p_disabled: disabled,
    });
    if (error) throw error;
    return data;
  }

  function storePublicUrl(slug) {
    if (window.location.pathname.includes("/agent/") || window.location.pathname.includes("/admin/")) {
      return new URL(`../store.html?s=${encodeURIComponent(slug)}`, window.location.href).href;
    }
    return new URL(`store.html?s=${encodeURIComponent(slug)}`, window.location.href).href;
  }

  return {
    client,
    getSession,
    getUser,
    getProfile,
    requireProfile,
    syncAgentActivation,
    routeAgentAfterAuth,
    signUp,
    signIn,
    signOut,
    fetchPackages,
    upsertPackage,
    deletePackage,
    getStoreByAgent,
    getStoreBySlug,
    saveStore,
    placeOrder,
    placeOrderWithWallet,
    fulfillOrder,
    providerBalance,
    myOrders,
    allOrders,
    updateOrder,
    allUsers,
    updateUserRole,
    allStores,
    adminDashboardData,
    getWallet,
    getWalletTransactions,
    getWithdrawals,
    requestWithdrawal,
    reviewWithdrawal,
    getAgentStorePrices,
    setAgentPackageProfit,
    trackOrdersByPhone,
    getSiteSettings,
    updateSiteSettings,
    adminCreditWallet,
    adminSetBlocked,
    getUserCustomPrices,
    adminSetCustomPrice,
    ordersForUser,
    listApiKeys,
    createApiKey,
    revokeApiKey,
    adminApiConsole,
    adminCreateUserApiKey,
    adminRevokeApiKey,
    adminSetApiDisabled,
    storePublicUrl,
  };
})();
