// RALD PayRald Core — Wallet Provisioning (Internal)
// Called by rald-event-bus identity provisioning chain
// POST /internal/wallets/provision
// LILCKY STUDIO LIMITED

import { Hono }               from "hono";
import type { Bindings, Variables } from "../index";

const wallets = new Hono<{ Bindings: Bindings; Variables: Variables }>();

wallets.post("/internal/wallets/provision", async (c) => {
  const provided = c.req.header("X-Internal-Secret");
  if (!provided || provided !== c.env.MACHINE_IDENTITY_SECRET) {
    return c.json({ error: "Forbidden", code: "UNAUTHORIZED" }, 403);
  }

  const body = await c.req.json<{
    user_id:   string;
    rald_id?:  string;
    currency?: string;
    kyc_tier?: number;
  }>().catch(() => null);

  if (!body?.user_id) {
    return c.json({ error: "user_id is required", code: "MISSING_FIELDS" }, 400);
  }

  const db       = c.get("db")!;
  const currency = body.currency ?? "NGN";
  const kyc_tier = body.kyc_tier ?? 1;

  // Idempotency — wallet already exists
  const { data: existing } = await db
    .from("payrald_wallets")
    .select("id")
    .eq("user_id", body.user_id)
    .maybeSingle();

  if (existing) {
    return c.json({ ok: true, wallet_id: existing.id, user_id: body.user_id, idempotent: true });
  }

  const wallet_id = `wal_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const { data: wallet, error } = await db.from("payrald_wallets").insert({
    id:                wallet_id,
    user_id:           body.user_id,
    currency,
    available_balance: 0,
    total_balance:     0,
    daily_limit:       kyc_tier === 1 ? 50_000 : 500_000,
    daily_used:        0,
    kyc_tier,
    is_frozen:         false,
    last_activity_at:  new Date().toISOString(),
  }).select("id").single();

  if (error) {
    console.error("[wallets/provision]", error.message);
    return c.json({ error: "Failed to create wallet", code: "DB_ERROR" }, 500);
  }

  // Grant free product access (best-effort)
  await db.from("product_access").upsert({
    user_id:    body.user_id,
    product:    "payrald",
    tier:       "free",
    granted_at: new Date().toISOString(),
  }, { onConflict: "user_id,product", ignoreDuplicates: true });

  return c.json({
    ok:          true,
    wallet_id:   wallet.id,
    user_id:     body.user_id,
    currency,
    kyc_tier,
    daily_limit: kyc_tier === 1 ? 50_000 : 500_000,
    idempotent:  false,
  }, 201);
});

export default wallets;
