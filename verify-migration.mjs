/**
 * Post-migration verification using the Supabase REST API (anon key).
 * Confirms key tables exist and are accessible.
 */

const URL_BASE  = process.env.SUPABASE_URL ?? "https://onxdcikfttdmnhofsuwo.supabase.co";
const SVC_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function checkTable(tableName) {
  const r = await fetch(`${URL_BASE}/rest/v1/${tableName}?limit=1&select=count`, {
    headers: {
      apikey: SVC_KEY,
      Authorization: `Bearer ${SVC_KEY}`,
      "Content-Type": "application/json",
      Prefer: "count=exact",
    },
  });
  const count = r.headers.get("content-range")?.split("/")[1] ?? "?";
  if (r.ok || r.status === 416) {
    console.log(`  ✅  ${tableName.padEnd(40)} rows: ${count}`);
  } else {
    const body = await r.text();
    console.error(`  ❌  ${tableName.padEnd(40)} ${r.status} ${body.slice(0, 120)}`);
  }
}

console.log("\n🔍  Verifying migration via REST API…\n");

const tables = [
  "waitlist",
  "payrald_wallets",
  "payrald_transactions",
  "payrald_transfers",
  "payrald_withdrawals",
  "payrald_payments",
  "payrald_merchant_profiles",
  "payrald_voucher_products",
  "payrald_wallet_events",
  "payrald_wallet_reservations",
  "payrald_wallet_limits",
];

for (const t of tables) {
  await checkTable(t);
}
console.log("\nDone.\n");
