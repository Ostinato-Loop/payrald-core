// RALD PayRald Core — Digital Voucher Marketplace
// Buy Spotify, Netflix, Google Play, Apple, Steam, ChatGPT Plus, etc. with your RALD wallet.
// No international card required — pay in NGN.
// LILCKY STUDIO LIMITED

import { Hono }                      from "hono";
import type { Bindings, Variables }  from "../index";
import { authRequired }              from "../middleware/auth";
import { publishEvent }              from "../lib/events";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── GET /v1/vouchers/products ─────────────────────────────────────────────────
app.get("/v1/vouchers/products", async (c) => {
  const db       = c.get("db");
  const category = c.req.query("category");
  const q        = db.from("payrald_voucher_products")
    .select("id,name,slug,provider,category,description,logo_url,price_ngn,face_value,currency,delivery_type,instructions,in_stock,stock_count")
    .eq("is_active", true)
    .order("category").order("price_ngn");
  const { data, error } = category ? await (q as any).eq("category", category) : await q;
  if (error) return c.json({ error: "Failed to fetch products" }, 500);
  return c.json({ data: data ?? [] });
});

// ── GET /v1/vouchers/products/:slug ───────────────────────────────────────────
app.get("/v1/vouchers/products/:slug", async (c) => {
  const db   = c.get("db");
  const slug = c.req.param("slug");
  const { data, error } = await db.from("payrald_voucher_products")
    .select("id,name,slug,provider,category,description,logo_url,price_ngn,face_value,currency,delivery_type,instructions,in_stock,stock_count")
    .eq("slug", slug).eq("is_active", true).maybeSingle();
  if (error || !data) return c.json({ error: "Product not found" }, 404);
  return c.json(data);
});

// ── POST /v1/vouchers/purchase ────────────────────────────────────────────────
app.post("/v1/vouchers/purchase", authRequired(), async (c) => {
  const user = c.get("user")!;
  const db   = c.get("db");
  const body = await c.req.json<{ productSlug: string; quantity?: number }>();

  if (!body.productSlug) return c.json({ error: "productSlug is required" }, 400);
  const qty = Math.max(1, Math.min(body.quantity ?? 1, 5)); // max 5 per purchase

  // 1. Fetch product
  const { data: product, error: productErr } = await db.from("payrald_voucher_products")
    .select("*").eq("slug", body.productSlug).eq("is_active", true).maybeSingle();
  if (productErr || !product) return c.json({ error: "Product not found or unavailable", code: "PRODUCT_NOT_FOUND" }, 404);
  if (!product.in_stock || product.stock_count < qty) {
    return c.json({ error: "Product is out of stock", code: "OUT_OF_STOCK", product_name: product.name }, 422);
  }

  const totalAmount = product.price_ngn * qty;

  // 2. Check wallet balance
  const { data: wallet, error: walletErr } = await db.from("payrald_wallets")
    .select("id,available_balance,total_balance,is_frozen,daily_used,daily_limit")
    .eq("user_id", user.id).maybeSingle();
  if (walletErr || !wallet) return c.json({ error: "Wallet not found", code: "WALLET_NOT_FOUND" }, 404);
  if (wallet.is_frozen) return c.json({ error: "Wallet is frozen", code: "WALLET_FROZEN" }, 422);
  if (wallet.available_balance < totalAmount) return c.json({ error: "Insufficient balance", code: "INSUFFICIENT_BALANCE", available: wallet.available_balance, required: totalAmount }, 422);
  if (wallet.daily_used + totalAmount > wallet.daily_limit) return c.json({ error: "Daily limit exceeded", code: "DAILY_LIMIT_EXCEEDED" }, 422);

  // 3. Reserve inventory (FIFO — get oldest unsold voucher codes)
  const { data: inventory, error: invErr } = await db.from("payrald_voucher_inventory")
    .select("id,code,pin,face_value").eq("product_id", product.id).eq("is_sold", false)
    .order("created_at").limit(qty);

  // 4. Debit wallet
  const newAvailable = wallet.available_balance - totalAmount;
  const newTotal     = wallet.total_balance - totalAmount;
  const { error: debitErr } = await db.from("payrald_wallets")
    .update({ available_balance: newAvailable, total_balance: newTotal, daily_used: wallet.daily_used + totalAmount, last_activity_at: new Date().toISOString() })
    .eq("id", wallet.id);
  if (debitErr) return c.json({ error: "Failed to debit wallet" }, 500);

  const purchaseResults: Array<{ purchase_id: string; product_name: string; code: string | null; pin: string | null; face_value: string; instructions: string | null; status: string }> = [];

  for (let i = 0; i < qty; i++) {
    const inventoryItem = inventory?.[i];

    // 5. Create purchase record
    const { data: purchase } = await db.from("payrald_voucher_purchases").insert({
      user_id:      user.id,
      product_id:   product.id,
      product_slug: product.slug,
      product_name: product.name,
      inventory_id: inventoryItem?.id ?? null,
      amount_paid:  product.price_ngn,
      currency:     "NGN",
      status:       inventoryItem ? "completed" : "pending",
      code_revealed: !!inventoryItem,
      delivered_at: inventoryItem ? new Date().toISOString() : null,
    }).select().single();

    // 6. Mark inventory as sold
    if (inventoryItem && purchase) {
      await db.from("payrald_voucher_inventory").update({
        is_sold: true, sold_to: user.id, sold_at: new Date().toISOString(), purchase_id: purchase.id,
      }).eq("id", inventoryItem.id).catch(console.error);

      await db.from("payrald_voucher_products").update({ stock_count: product.stock_count - (i + 1) })
        .eq("id", product.id).catch(console.error);
    }

    purchaseResults.push({
      purchase_id:  purchase?.id ?? crypto.randomUUID(),
      product_name: product.name,
      code:         inventoryItem?.code ?? null,
      pin:          inventoryItem?.pin ?? null,
      face_value:   inventoryItem?.face_value ?? product.face_value,
      instructions: product.instructions,
      status:       inventoryItem ? "delivered" : "pending_fulfillment",
    });
  }

  // 7. Ledger entry
  await db.from("payrald_transactions").insert({
    user_id: user.id, type: "voucher", direction: "debit",
    amount: totalAmount, fee: 0, currency: "NGN", status: "completed",
    provider: "internal", provider_ref: `voucher_${purchaseResults[0]?.purchase_id ?? ""}`,
    narration: `Voucher: ${product.name}${qty > 1 ? ` x${qty}` : ""}`,
    metadata: { product_slug: product.slug, quantity: qty },
  }).catch(console.error);

  // 8. Wallet event
  await db.from("payrald_wallet_events").insert({
    wallet_id: wallet.id, user_id: user.id, event_type: "debit_voucher",
    amount: totalAmount, balance_before: wallet.available_balance, balance_after: newAvailable,
    reference: purchaseResults[0]?.purchase_id ?? null,
  }).catch(console.error);

  // 9. Publish events
  c.executionCtx.waitUntil(
    Promise.all(purchaseResults.map(r =>
      publishEvent({
        eventType: "voucher.issued", source: "payrald-core", userId: user.id,
        payload: { purchase_id: r.purchase_id, product_slug: product.slug, product_name: product.name, amount: product.price_ngn, currency: "NGN", delivered: r.status === "delivered" },
        machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
      })
    ))
  );

  return c.json({
    ok:      true,
    vouchers: purchaseResults,
    total_paid: totalAmount,
    wallet:  { available_balance: newAvailable, currency: "NGN" },
    note:    purchaseResults.some(r => r.status === "pending_fulfillment")
      ? "Some vouchers will be delivered via email within 30 minutes as we restock inventory."
      : undefined,
  }, 201);
});

// ── GET /v1/vouchers/purchases ────────────────────────────────────────────────
app.get("/v1/vouchers/purchases", authRequired(), async (c) => {
  const user   = c.get("user")!;
  const db     = c.get("db");
  const limit  = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const cursor = c.req.query("cursor");

  let q = db.from("payrald_voucher_purchases")
    .select("id,product_slug,product_name,amount_paid,currency,status,code_revealed,delivered_at,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) return c.json({ error: "Failed to fetch purchases" }, 500);
  const hasMore = data.length > limit;
  const rows    = hasMore ? data.slice(0, limit) : data;
  return c.json({ data: rows, next_cursor: hasMore ? rows[rows.length - 1]?.created_at ?? null : null });
});

// ── GET /v1/vouchers/purchases/:id ────────────────────────────────────────────
app.get("/v1/vouchers/purchases/:id", authRequired(), async (c) => {
  const user = c.get("user")!;
  const db   = c.get("db");
  const { data, error } = await db.from("payrald_voucher_purchases")
    .select("id,product_id,product_slug,product_name,amount_paid,currency,status,code_revealed,delivered_at,created_at,inventory_id")
    .eq("id", c.req.param("id")).eq("user_id", user.id).maybeSingle();
  if (error || !data) return c.json({ error: "Purchase not found" }, 404);

  let code: string | null = null;
  let pin:  string | null = null;
  if (data.inventory_id && data.code_revealed) {
    const { data: inv } = await db.from("payrald_voucher_inventory").select("code,pin").eq("id", data.inventory_id).maybeSingle();
    code = inv?.code ?? null;
    pin  = inv?.pin  ?? null;
  }

  return c.json({ ...data, code, pin });
});

export default app;
