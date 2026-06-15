// RALD PayRald Core — Squad Co webhook handler
// Processes: charge_successful, virtual_account_transfer_successful,
//            transfer_success, transfer_failed, payout_completed, payout_failed
// LILCKY STUDIO LIMITED

import { Hono }                    from "hono";
import type { Bindings, Variables } from "../index";
import { squadClient }             from "../lib/squad";
import { publishEvent }            from "../lib/events";
import { creditWallet, reverseDebit, updateByProviderRef } from "../lib/supabase";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.post("/webhooks/squad", async (c) => {
  const rawBody  = await c.req.text();
  const signature = c.req.header("x-squad-encrypted-body") ?? c.req.header("x-squad-signature") ?? "";
  const db        = c.get("db");

  // 1. Verify signature
  const squad = squadClient(c.env);
  if (signature) {
    const valid = await squad.verifyWebhookSignature(rawBody, signature);
    if (!valid) {
      console.warn("[payrald-core/webhooks] invalid Squad signature");
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const eventType = (event.Event ?? event.event_type ?? "") as string;
  const body      = (event.Body ?? event.data ?? {}) as Record<string, unknown>;
  const txRef     = (body.transaction_ref ?? body.reference ?? event.TransactionRef ?? "") as string;

  // 2. Log the event
  await db.from("payrald_webhook_events").insert({
    provider: "squad", event_type: eventType,
    event_ref: txRef || null, payload: event, processed: false,
  }).catch(console.error);

  // ── Top-up: virtual account credited ──────────────────────────────────────
  if (eventType === "charge_successful" || eventType === "virtual_account_transfer_successful") {
    const customerIdentifier = (body.customer_identifier ?? "") as string;
    const amountKobo = (body.amount ?? 0) as number;
    const amountNgn  = amountKobo / 100;
    const ref        = txRef || crypto.randomUUID();

    if (customerIdentifier && amountNgn > 0) {
      const userId = customerIdentifier.replace(/^payrald_/, "");
      try {
        await creditWallet(db, userId, amountNgn);
        await db.from("payrald_transactions").insert({
          user_id: userId, type: "top_up", direction: "credit",
          amount: amountNgn, fee: 0, currency: "NGN", status: "completed",
          provider: "squad", provider_ref: ref,
          narration: "Wallet top-up via virtual account",
          metadata: { event_type: eventType, customer_identifier: customerIdentifier, raw_amount_kobo: amountKobo },
        }).catch(console.error);

        c.executionCtx.waitUntil(
          publishEvent({
            eventType: "wallet.credited", source: "payrald-core", userId,
            payload: { amount: amountNgn, currency: "NGN", provider: "squad", provider_ref: ref },
            machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
          })
        );
      } catch (err) {
        console.error("[payrald-core/webhooks] top-up credit failed:", err);
      }
    }
  }

  // ── Payout completed ────────────────────────────────────────────────────
  if (eventType === "transfer_success" || eventType === "payout_completed") {
    if (txRef) {
      await Promise.all([
        updateByProviderRef(db, "payrald_transfers",    txRef, "completed"),
        updateByProviderRef(db, "payrald_withdrawals",  txRef, "completed"),
        updateByProviderRef(db, "payrald_transactions", txRef, "completed"),
      ]).catch(console.error);

      // Get user_id from transaction to publish event
      const { data: tx } = await db.from("payrald_transactions")
        .select("user_id, amount, type").eq("provider_ref", txRef).maybeSingle();

      if (tx) {
        c.executionCtx.waitUntil(
          publishEvent({
            eventType: "payment.completed", source: "payrald-core", userId: tx.user_id,
            payload: { provider_ref: txRef, amount: tx.amount, type: tx.type },
            machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
          })
        );
      }
    }
  }

  // ── Payout failed — reverse debit ──────────────────────────────────────
  if (eventType === "transfer_failed" || eventType === "payout_failed") {
    if (txRef) {
      // Find the transfer/withdrawal to reverse
      const { data: transfer } = await db.from("payrald_transfers")
        .select("id,user_id,amount,fee").eq("provider_ref", txRef).maybeSingle();

      if (transfer) {
        await reverseDebit(db, transfer.user_id, transfer.amount + (transfer.fee ?? 0)).catch(console.error);
        await updateByProviderRef(db, "payrald_transfers", txRef, "failed").catch(console.error);
      }

      const { data: withdrawal } = await db.from("payrald_withdrawals")
        .select("id,user_id,amount,fee").eq("provider_ref", txRef).maybeSingle();

      if (withdrawal) {
        await reverseDebit(db, withdrawal.user_id, withdrawal.amount + (withdrawal.fee ?? 0)).catch(console.error);
        await updateByProviderRef(db, "payrald_withdrawals", txRef, "failed").catch(console.error);
      }

      await updateByProviderRef(db, "payrald_transactions", txRef, "failed").catch(console.error);

      const userId = transfer?.user_id ?? withdrawal?.user_id;
      if (userId) {
        c.executionCtx.waitUntil(
          publishEvent({
            eventType: "payment.failed", source: "payrald-core", userId,
            payload: { provider_ref: txRef, event_type: eventType },
            machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
          })
        );
      }
    }
  }

  // Mark event processed
  await db.from("payrald_webhook_events")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("event_ref", txRef || "").catch(console.error);

  return c.json({ ok: true });
});

export default app;
