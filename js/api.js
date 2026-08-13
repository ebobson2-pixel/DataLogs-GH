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
    const { data } = await client.auth.getUser();
    return data.user;
  }

  async function getProfile() {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", user.id).single();
    if (error) throw error;
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
    if (roles && !roles.includes(profile.role)) {
      window.location.href = loginUrl;
      return null;
    }
    return profile;
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
    return { ok: true, data };
  }

  async function signOut() {
    await client.auth.signOut();
  }

  async function fetchPackages({ includeInactive = false } = {}) {
    let query = client.from("packages").select("*").order("sort_order", { ascending: true });
    if (!includeInactive) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(mapPackage);
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

  async function myOrders() {
    const { data, error } = await client
      .from("orders")
      .select("*, agent_stores(name, slug)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function allOrders() {
    const { data, error } = await client
      .from("orders")
      .select("*, profiles:buyer_id(full_name, email, phone), agent_stores(name, slug)")
      .order("created_at", { ascending: false });
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
      .select("*, profiles:agent_id(full_name, email)")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getWallet() {
    const profile = await getProfile();
    if (!profile) return null;
    const { data, error } = await client.from("wallets").select("*").eq("agent_id", profile.id).maybeSingle();
    if (error) throw error;
    return data || { agent_id: profile.id, balance: 0 };
  }

  async function getWalletTransactions() {
    const { data, error } = await client
      .from("wallet_transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  }

  async function getWithdrawals() {
    const { data, error } = await client
      .from("withdrawals")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function requestWithdrawal({ amount, momoNumber, accountName }) {
    const { data, error } = await client.rpc("request_withdrawal", {
      p_amount: Number(amount),
      p_momo_number: momoNumber,
      p_account_name: accountName || null,
      p_method: "momo",
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
    myOrders,
    allOrders,
    updateOrder,
    allUsers,
    updateUserRole,
    allStores,
    getWallet,
    getWalletTransactions,
    getWithdrawals,
    requestWithdrawal,
    getAgentStorePrices,
    setAgentPackageProfit,
    trackOrdersByPhone,
    storePublicUrl,
  };
})();
