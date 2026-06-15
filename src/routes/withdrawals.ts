// RALD PayRald Core — Withdrawals
// Bank account withdrawals via Squad Co payout API
// LILCKY STUDIO LIMITED

import { Hono }                     from "hono";
import { zValidator }               from "@hono/zod-validator";
import { z }                        from "zod";
import type { Bindings, Variables }  from "../index";
import { authRequired }             from "../middleware/auth";
import { squadClient }              from "../lib/squad";
import { publishEvent }             from "../lib/events";
import { debitWallet, reverseDebit, createTransaction, updateTransactionStatus, getWallet } from "../lib/supabase";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const WithdrawBody = z.object({
  bank_code:      z.string().min(2).max(6),
  account_number: z.string().length(10),
  account_name:   z.string().min(2),
  amount:         z.number().positive(),
  currency:       z.string().default("NGN"),
  narration:      z.string().optional(),
});

// ── POST /v1/withdrawals ────────────────────────────────────────────────────
app.post("/withdrawals", authRequired(), zValidator("json", WithdrawBody), async (c) => {
  const user = c.get("user")!;
  const db   = c.get("db");
  const { bank_code, account_number, account_name, amount, currency, narration } = c.req.valid("json");
  const txRef = `pay_wdrl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  // 1. Wallet check
  const wallet = await getWallet(db, user.id);
  if (!wallet)          return c.json({ error: "Wallet not found", code: "WALLET_NOT_FOUND" }, 422);
  if (wallet.is_frozen) return c.json({ error: wallet.freeze_reason ?? "Wallet is frozen", code: "WALLET_FROZEN" }, 422);
  if (wallet.available_balance < amount) {
    return c.json({ error: `Insufficient balance. Available: ₦${wallet.available_balance.toLocaleString()}`, code: "INSUFFICIENT_BALANCE" }, 422);
  }

  // 2. Verify account name via Squad (optional confirmation step)
  const squad = squadClient(c.env);
  let verifiedName = account_name;
  try {
    const lookup = await squad.verifyAccountName({ accountNumber: account_number, bankCode: bank_code });
    verifiedName = lookup.account_name;
  } catch {
    // Non-fatal — proceed with provided name
  }

  // 3. Create pending transaction + debit wallet atomically
  const [txRow] = await Promise.all([
    createTransaction(db, {
      user_id: user.id, type: "withdrawal", direction: "debit",
      amount, fee: 0, currency, status: "pending", provider: "squad",
      recipient_name: verifiedName, recipient_bank_code: bank_code,
      narration: narration ?? `Withdrawal to ${bank_code}/${account_number}`,
      metadata: { tx_ref: txRef, account_number, bank_code },
    }),
    debitWallet(db, user.id, amount),
  ]);

  // 4. Execute via Squad Co
  let providerRef: string | null = null;
  let finalStatus = "processing";

  try {
    const payout = await squad.initiateTransfer({
      accountNumber: account_number, accountName: verifiedName,
      bankCode: bank_code, amountNgn: amount,
      remark: narration ?? `PayRald withdrawal`,
      transactionRef: txRef,
    });
    providerRef = payout.transaction_reference;
  } catch (err) {
    await reverseDebit(db, user.id, amount).catch(console.error);
    await updateTransactionStatus(db, txRow.id, "failed").catch(console.error);
    console.error("[payrald-core] Squad withdrawal error:", err);
    return c.json({ error: "Withdrawal failed. Amount not deducted. Please try again.", code: "PROVIDER_ERROR" }, 502);
  }

  await updateTransactionStatus(db, txRow.id, finalStatus, providerRef ?? undefined);

  // 5. Insert withdrawal record
  await db.from("payrald_withdrawals").insert({
    user_id: user.id, bank_code, bank_name: null,
    account_number, account_name: verifiedName,
    amount, fee: 0, currency, status: finalStatus,
    provider: "squad", provider_ref: providerRef,
    narration: narration ?? null,
    metadata: { tx_ref: txRef, transaction_id: txRow.id },
  });

  // 6. Publish event (non-blocking)
  c.executionCtx.waitUntil(
    publishEvent({
      eventType: "withdrawal.initiated",
      source:    "payrald-core",
      userId:    user.id,
      payload:   { tx_ref: txRef, bank_code, amount, currency, status: finalStatus, provider_ref: providerRef },
      machineSecret: c.env.MACHINE_IDENTITY_SECRET,
      eventBusUrl:   c.env.EVENT_BUS_URL,
    })
  );

  return c.json({
    ok: true,
    withdrawal: {
      id: txRow.id, ref: txRef, status: finalStatus,
      amount, currency, fee: 0,
      destination: { bank_code, account_number, account_name: verifiedName },
      provider_ref: providerRef,
      created_at: txRow.created_at,
    },
  }, 201);
});

// ── GET /v1/withdrawals ─────────────────────────────────────────────────────
app.get("/withdrawals", authRequired(), async (c) => {
  const db     = c.get("db");
  const user   = c.get("user")!;
  const limit  = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const cursor = c.req.query("cursor");

  let q = db.from("payrald_withdrawals")
    .select("id,bank_code,bank_name,account_number,account_name,amount,fee,currency,status,provider_ref,narration,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) throw error;

  const hasMore = data.length > limit;
  const rows    = hasMore ? data.slice(0, limit) : data;
  return c.json({ data: rows, next_cursor: hasMore ? rows[rows.length - 1]?.created_at ?? null : null });
});

// ── GET /v1/withdrawals/:id ─────────────────────────────────────────────────
app.get("/withdrawals/:id", authRequired(), async (c) => {
  const db   = c.get("db");
  const user = c.get("user")!;
  const { data, error } = await db.from("payrald_withdrawals")
    .select("*").eq("id", c.req.param("id")).eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  if (!data) return c.json({ error: "Withdrawal not found" }, 404);
  return c.json(data);
});

// ── POST /v1/withdrawals/verify-account ────────────────────────────────────
app.post("/withdrawals/verify-account", authRequired(), async (c) => {
  const body = await c.req.json<{ bank_code?: string; account_number?: string }>().catch(() => null);
  if (!body?.bank_code || !body?.account_number) {
    return c.json({ error: "bank_code and account_number required" }, 400);
  }
  try {
    const squad  = squadClient(c.env);
    const result = await squad.verifyAccountName({ accountNumber: body.account_number, bankCode: body.bank_code });
    return c.json({ ok: true, account_name: result.account_name, account_number: result.account_number, bank_code: result.bank_code });
  } catch (err) {
    return c.json({ ok: false, error: "Could not verify account. Check details and try again." }, 422);
  }
});

export default app;
