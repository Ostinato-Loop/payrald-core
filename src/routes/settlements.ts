// RALD PayRald Core — Settlement Engine
// Schedules and processes merchant + withdrawal settlements.
// Internal service route — no user auth, machine-to-machine only.
// LILCKY STUDIO LIMITED

import { Hono }                      from "hono";
import type { Bindings, Variables }  from "../index";
import { signMachineJwt }            from "../lib/auth";
import { publishEvent }              from "../lib/events";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function internalAuth(): (c: any, next: any) => Promise<Response | void> {
  return async (c, next) => {
    const secret = c.req.header("X-Internal-Secret");
    if (secret !== c.env.MACHINE_IDENTITY_SECRET) return c.json({ error: "Unauthorized" }, 401);
    await next();
  };
}

// ── GET /v1/settlements — list pending ────────────────────────────────────────
app.get("/v1/settlements", internalAuth(), async (c) => {
  const db     = c.get("db");
  const status = c.req.query("status") ?? "pending";
  const type   = c.req.query("type");
  let q = db.from("payrald_settlements").select("*").eq("status", status).order("created_at");
  if (type) q = (q as any).eq("settlement_type", type);
  const { data, error } = await q.limit(50);
  if (error) return c.json({ error: "Failed to fetch settlements" }, 500);
  return c.json({ data: data ?? [], count: data?.length ?? 0 });
});

// ── POST /v1/settlements/batch — create settlement batch ──────────────────────
app.post("/v1/settlements/batch", internalAuth(), async (c) => {
  const db = c.get("db");

  // Grab all pending settlements
  const { data: pending, error: fetchErr } = await db.from("payrald_settlements")
    .select("id,settlement_type,amount,fee,currency,merchant_alias,user_id")
    .eq("status", "pending").limit(100);
  if (fetchErr) return c.json({ error: "Failed to fetch pending settlements" }, 500);
  if (!pending || pending.length === 0) return c.json({ ok: true, message: "No pending settlements", batch_id: null });

  const totalAmount = pending.reduce((s: number, r: any) => s + Number(r.amount), 0);
  const totalFee    = pending.reduce((s: number, r: any) => s + Number(r.fee), 0);

  // Create batch
  const { data: batch } = await db.from("payrald_settlement_batches").insert({
    total_amount: totalAmount, total_fee: totalFee, item_count: pending.length, status: "processing",
  }).select().single();

  // Link settlements to batch
  await db.from("payrald_settlements")
    .update({ status: "processing", batch_id: batch?.id ?? null })
    .in("id", pending.map((r: any) => r.id)).catch(console.error);

  c.executionCtx.waitUntil(
    publishEvent({
      eventType: "settlement.completed", source: "payrald-core",
      payload: { batch_id: batch?.id, total_amount: totalAmount, item_count: pending.length },
      machineSecret: c.env.MACHINE_IDENTITY_SECRET, eventBusUrl: c.env.EVENT_BUS_URL,
    })
  );

  return c.json({ ok: true, batch_id: batch?.id, item_count: pending.length, total_amount: totalAmount });
});

// ── GET /v1/settlements/batches ───────────────────────────────────────────────
app.get("/v1/settlements/batches", internalAuth(), async (c) => {
  const db = c.get("db");
  const { data, error } = await db.from("payrald_settlement_batches")
    .select("*").order("created_at", { ascending: false }).limit(20);
  if (error) return c.json({ error: "Failed to fetch batches" }, 500);
  return c.json({ data: data ?? [] });
});

export default app;
