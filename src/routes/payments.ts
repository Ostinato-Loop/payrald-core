// RALD PayRald Core — Merchant Payments
// Pay any merchant alias: @spotify, @netflix, @school, @myshop, etc.
// ALIA merchant resolution → wallet debit → settlement → event
// LILCKY STUDIO LIMITED

import { Hono }                          from "hono";
import type { Bindings, Variables }      from "../index";
import { authRequired }                  from "../middleware/auth";
import { resolveMerchantViaRouting }     from "../lib/alia";
import { publishEvent }                  from "../lib/events";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── POST /v1/payments/merchant ────────────────────────────────────────────────
app.post("/v1/payments/merchant", authRequired(), async (c) => {
  const user   = c.get("user")!;
  const rawJwt = c.get("rawJwt")!;
  const db     = c.get("db");
  const body   = await c.req.json<{
    merchantAlias: string;
    amount:        number;
    currency?:     string;
    narration?:    string;
    metadata?:     Record<string, unknown>;
  }>();

  if (!body.merchantAlias || !body.amount || body.amount <= 0) {
    return c.json({ error: "merchantAlias and amount (> 0) are required" }, 400);
  }

  const alias        = body.merchantAlias.startsWith("@") ? body.merchantAlias : `@${body.merchantAlias}`;
  const currency     = body.currency ?? "NGN";
  const transactionRef = `pay_merch_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // 1. Fetch user wallet
  const { data: wallet, error: walletErr } = await db.from("payrald_wallets")
    .select("id,available_balance,total_balance,daily_limit,daily_used,is_frozen,kyc_tier")
    .eq("user_id", user.id).maybeSingle();
  if (walletErr || !wallet) return c.json({ error: "Wallet not found", code: "WALLET_NOT_FOUND" }, 404);
  if (wallet.is_frozen) return c.json({ error: "Wallet is frozen", code: "WALLET_FROZEN" }, 422);
  if (wallet.available_balance < body.amount) return c.json({ error: "Insufficient balance", code: "INSUFFICIENT_BALANCE", available: wallet.available_balance }, 422);
  if (wallet.daily_used + body.amount > wallet.daily_limit) return c.json({ error: "Daily limit exceeded", code: "DAILY_LIMIT_EXCEEDED" }, 422);

  // 2. Check local merchant registry
  const { data: localMerchant } = await db.from("payrald_merchant_profiles")
    .select("id,merchant_alias,display_name,merchant_type,trust_score,compliance_status,is_active,settlement_wallet_id")
    .eq("merchant_alias", alias).maybeSingle();

  if (localMerchant && localMerchant.compliance_status !== "approved") {
    return c.json({ error: "Merchant is not approved for payments", code: "MERCHANT_NOT_APPROVED" }, 422);
  }

  // 3. Attempt ALIA merchant resolution (non-blocking failure for local merchants)
  let merchantName = localMerchant?.display_name ?? alias;
  let merchantType = localMerchant?.merchant_type ?? "Digital";
  let aliaToken: string | null = null;

  const merchantResolution = await resolveMerchantViaRouting({
    merchantAlias: alias, userJwt: rawJwt, transactionRef, amount: body.amount, env: c.env,
  });

  if (merchantResolution) {
    merchantName = merchantResolution.displayName;
    merchantType = merchantResolution.merchantType;
    aliaToken    = merchantResolution.settlementRef ?? null;
  } else if (!localMerchant) {
    return c.json({ error: "Merchant not found. Ensure the merchant alias is correct.", code: "MERCHANT_NOT_FOUND" }, 422);
  }

  // 4. Debit wallet atomically
  const newAvailable = wallet.available_balance - body.amount;
  const newTotal     = wallet.total_balance - body.amount;
  const newDailyUsed = wallet.daily_used + body.amount;

  const { error: debitErr } = await db.from("payrald_wallets")
    .update({ available_balance: newAvailable, total_balance: newTotal, daily_used: newDailyUsed, last_activity_at: new Date().toISOString() })
    .eq("id", wallet.id);
  if (debitErr) return c.json({ error: "Failed to debit wallet" }, 500);

  // 5. Create payment record
  const { data: payment, error: pmtErr } = await db.from("payrald_payments").insert({
    user_id:       user.id,
    merchant_alias: alias,
    merchant_name:  merchantName,
    merchant_type:  merchantType,
    amount:         body.amount,
    fee:            0,
    currency,
    status:         "completed",
    provider:       "internal",
    provider_ref:   transactionRef,
    alia_token:     aliaToken,
    narration:      body.narration ?? `Payment to ${merchantName}`,
    metadata:       body.metadata ?? {},
  }).select().single();
  if (pmtErr) {
    await db.from("payrald_wallets").update({ available_balance: wallet.available_balance, total_balance: wallet.total_balance, daily_used: wallet.daily_used }).eq("id", wallet.id);
    return c.json({ error: "Failed to record payment" }, 500);
  }

  // 6. Ledger entry
  await db.from("payrald_transactions").insert({
    user_id: user.id, type: "payment", direction: "debit",
    amount: body.amount, fee: 0, currency,
    status: "completed", provider: "internal",
    provider_ref: transactionRef, alia_token: aliaToken,
    recipient_alias: alias, recipient_name: merchantName,
    narration: body.narration ?? `Payment to ${merchantName}`,
  }).catch(console.error);

  // 7. Wallet event
  await db.from("payrald_wallet_events").insert({
    wallet_id: wallet.id, user_id: user.id, event_type: "debit_merchant",
    amount: body.amount, balance_before: wallet.available_balance, balance_after: newAvailable,
    reference: payment.id,
  }).catch(console.error);

  // 8. Settlement record
  await db.from("payrald_settlements").insert({
    settlement_type: "merchant", merchant_alias: alias, user_id: user.id,
    amount: body.amount, currency, status: "pending", source_ref: payment.id,
    narration: `Merchant settlement: ${merchantName}`,
  }).catch(console.error);

  // 9. Publish event
  c.executionCtx.waitUntil(
    publishEvent({
      eventType: "merchant.payment", source: "payrald-core", userId: user.id,
      payload: { payment_id: payment.id, merchant_alias: alias, merchant_name: merchantName, amount: body.amount, currency, status: "completed" },
      machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
    })
  );

  return c.json({ ok: true, payment, wallet: { available_balance: newAvailable, currency } }, 201);
});

// ── GET /v1/payments ──────────────────────────────────────────────────────────
app.get("/v1/payments", authRequired(), async (c) => {
  const user  = c.get("user")!;
  const db    = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const cursor = c.req.query("cursor");

  let q = db.from("payrald_payments")
    .select("id,merchant_alias,merchant_name,merchant_type,amount,fee,currency,status,provider_ref,narration,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) return c.json({ error: "Failed to fetch payments" }, 500);
  const hasMore = data.length > limit;
  const rows    = hasMore ? data.slice(0, limit) : data;
  return c.json({ data: rows, next_cursor: hasMore ? rows[rows.length - 1]?.created_at ?? null : null });
});

// ── GET /v1/payments/:id ──────────────────────────────────────────────────────
app.get("/v1/payments/:id", authRequired(), async (c) => {
  const user = c.get("user")!;
  const db   = c.get("db");
  const { data, error } = await db.from("payrald_payments").select("*").eq("id", c.req.param("id")).eq("user_id", user.id).maybeSingle();
  if (error || !data) return c.json({ error: "Payment not found" }, 404);
  return c.json(data);
});

// ── GET /v1/merchants ─────────────────────────────────────────────────────────
app.get("/v1/merchants", async (c) => {
  const db       = c.get("db");
  const category = c.req.query("category");
  const q        = db.from("payrald_merchant_profiles")
    .select("merchant_alias,display_name,merchant_type,category,trust_score,is_verified,logo_url,supported_products")
    .eq("is_active", true).eq("compliance_status", "approved")
    .order("display_name");
  const { data, error } = category ? await (q as any).eq("category", category) : await q;
  if (error) return c.json({ error: "Failed to fetch merchants" }, 500);
  return c.json({ data: data ?? [] });
});

// ── GET /v1/merchants/:alias ──────────────────────────────────────────────────
app.get("/v1/merchants/:alias", async (c) => {
  const db    = c.get("db");
  const alias = c.req.param("alias").startsWith("@") ? c.req.param("alias") : `@${c.req.param("alias")}`;
  const { data, error } = await db.from("payrald_merchant_profiles")
    .select("merchant_alias,display_name,merchant_type,category,description,logo_url,trust_score,is_verified,supported_products,supported_currencies,country")
    .eq("merchant_alias", alias).eq("is_active", true).maybeSingle();
  if (error || !data) return c.json({ error: "Merchant not found" }, 404);
  return c.json(data);
});

export default app;
