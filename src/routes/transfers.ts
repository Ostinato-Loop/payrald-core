// RALD PayRald Core — Transfers
// Alias-based transfers: ALIA resolution → Squad Co payout → event bus
// LILCKY STUDIO LIMITED

import { Hono }                    from "hono";
import { zValidator }              from "@hono/zod-validator";
import { z }                       from "zod";
import type { Bindings, Variables } from "../index";
import { authRequired }            from "../middleware/auth";
import { squadClient }             from "../lib/squad";
import { resolveAliasViaRouting, previewAlias, AliasResolutionError } from "../lib/alia";
import { publishEvent }            from "../lib/events";
import { debitWallet, reverseDebit, createTransaction, updateTransactionStatus, getWallet } from "../lib/supabase";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const InitiateBody = z.object({
  recipient:    z.string().min(1),
  amount:       z.number().positive(),
  currency:     z.string().default("NGN"),
  narration:    z.string().optional(),
  wallet_type:  z.string().default("Personal"),
});

// ── POST /v1/transfers ─────────────────────────────────────────────────────
app.post("/transfers", authRequired(), zValidator("json", InitiateBody), async (c) => {
  const user   = c.get("user")!;
  const rawJwt = c.get("rawJwt")!;
  const db     = c.get("db");
  const { recipient, amount, currency, narration, wallet_type } = c.req.valid("json");
  const txRef  = `pay_txfr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  // 1. Wallet check
  const wallet = await getWallet(db, user.id);
  if (!wallet) return c.json({ error: "Wallet not found. Please set up your wallet first.", code: "WALLET_NOT_FOUND" }, 422);
  if (wallet.is_frozen) return c.json({ error: wallet.freeze_reason ?? "Wallet is frozen", code: "WALLET_FROZEN" }, 422);
  if (wallet.available_balance < amount) return c.json({ error: `Insufficient balance. Available: ₦${wallet.available_balance.toLocaleString()}`, code: "INSUFFICIENT_BALANCE" }, 422);

  // 2. Resolve alias via ALIA
  let resolution: Awaited<ReturnType<typeof resolveAliasViaRouting>> | null = null;
  let recipientName = recipient;

  try {
    resolution = await resolveAliasViaRouting({
      alias: recipient, userJwt: rawJwt, transactionRef: txRef,
      currency, amount,
      routingUrl: c.env.ROUTING_URL,
    });
    recipientName = resolution.routing.accountName;
  } catch (err) {
    if (err instanceof AliasResolutionError) {
      if (err.httpStatus === 403) return c.json({ error: err.message, code: err.code }, 403);
      if (err.httpStatus === 404) return c.json({ error: `Recipient '${recipient}' not found in the RALD network.`, code: "RECIPIENT_NOT_FOUND" }, 422);
      // Allow internal transfers to proceed without ALIA if alias not found
      console.warn(`[payrald-core] ALIA resolution failed for ${recipient}: ${err.code}`);
    } else {
      console.error("[payrald-core] ALIA error:", err);
    }
  }

  // 3. Create pending transaction + debit wallet
  const [txRow] = await Promise.all([
    createTransaction(db, {
      user_id: user.id, type: "transfer", direction: "debit",
      amount, fee: 0, currency, status: "pending", provider: "squad",
      alia_token:          resolution?.token,
      recipient_alias:     recipient,
      recipient_name:      recipientName,
      recipient_bank:      resolution?.routing.destinationBankName,
      recipient_bank_code: resolution?.routing.destinationBankCode,
      narration: narration ?? `Transfer to ${recipientName}`,
      metadata:  { wallet_type, tx_ref: txRef },
    }),
    debitWallet(db, user.id, amount),
  ]);

  // 4. Execute payout via Squad Co
  let providerRef: string | null = null;
  let finalStatus = "completed";

  if (resolution) {
    try {
      const squad  = squadClient(c.env);
      const payout = await squad.initiateTransfer({
        accountNumber: resolution.token,
        accountName:   recipientName,
        bankCode:      resolution.routing.destinationBankCode,
        amountNgn:     amount,
        remark:        narration ?? `PayRald transfer`,
        transactionRef: txRef,
      });
      providerRef = payout.transaction_reference;
      finalStatus = "processing";
    } catch (err) {
      // Reverse debit on Squad failure
      await reverseDebit(db, user.id, amount).catch(console.error);
      await updateTransactionStatus(db, txRow.id, "failed").catch(console.error);
      console.error("[payrald-core] Squad payout error:", err);
      return c.json({ error: "Payment provider error. Amount not deducted. Please try again.", code: "PROVIDER_ERROR" }, 502);
    }
  }

  // 5. Update transaction with provider ref
  await updateTransactionStatus(db, txRow.id, finalStatus, providerRef ?? undefined);

  // 6. Insert transfer record
  await db.from("payrald_transfers").insert({
    user_id: user.id, recipient_alias: recipient, recipient_name: recipientName,
    recipient_bank_code: resolution?.routing.destinationBankCode ?? null,
    recipient_bank_name: resolution?.routing.destinationBankName ?? null,
    alia_token: resolution?.token ?? null,
    amount, fee: 0, currency, status: finalStatus,
    provider: "squad", provider_ref: providerRef,
    wallet_type, narration: narration ?? null,
    metadata: { tx_ref: txRef, transaction_id: txRow.id },
  });

  // 7. Publish event (non-blocking)
  c.executionCtx.waitUntil(
    publishEvent({
      eventType: "payment.initiated",
      source:    "payrald-core",
      userId:    user.id,
      payload:   { tx_ref: txRef, recipient, amount, currency, status: finalStatus, provider_ref: providerRef },
      machineSecret: c.env.MACHINE_IDENTITY_SECRET,
      eventBusUrl:   c.env.EVENT_BUS_URL,
    })
  );

  return c.json({
    ok: true,
    transaction: {
      id: txRow.id, ref: txRef, status: finalStatus,
      amount, currency, fee: 0,
      recipient: { alias: recipient, name: recipientName, bank: resolution?.routing.destinationBankName ?? null },
      provider_ref: providerRef,
      created_at: txRow.created_at,
    },
  }, 201);
});

// ── GET /v1/transfers ──────────────────────────────────────────────────────
app.get("/transfers", authRequired(), async (c) => {
  const db     = c.get("db");
  const user   = c.get("user")!;
  const limit  = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const cursor = c.req.query("cursor");

  let q = db.from("payrald_transfers")
    .select("id,recipient_alias,recipient_name,recipient_bank_name,amount,fee,currency,status,provider_ref,narration,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) throw error;

  const hasMore = data.length > limit;
  const rows    = hasMore ? data.slice(0, limit) : data;
  return c.json({
    data: rows,
    next_cursor: hasMore ? rows[rows.length - 1]?.created_at ?? null : null,
  });
});

// ── GET /v1/transfers/:id ──────────────────────────────────────────────────
app.get("/transfers/:id", authRequired(), async (c) => {
  const db   = c.get("db");
  const user = c.get("user")!;
  const { data, error } = await db.from("payrald_transfers")
    .select("*").eq("id", c.req.param("id")).eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  if (!data) return c.json({ error: "Transfer not found" }, 404);
  return c.json(data);
});

// ── GET /v1/transfers/preview ─────────────────────────────────────────────
// Preview recipient before initiating — no auth required for alias lookup
app.get("/transfers/preview", async (c) => {
  const alias = c.req.query("alias");
  if (!alias) return c.json({ error: "alias query parameter required" }, 400);
  const preview = await previewAlias({ alias, routingUrl: c.env.ROUTING_URL });
  return c.json(preview ?? { exists: false, display_name: null, verified: false });
});

export default app;
