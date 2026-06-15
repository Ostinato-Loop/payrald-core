/**
 * Supabase migration runner.
 * Uses the service role key as a JWT password via Supabase's session-mode pooler,
 * which accepts the service role JWT in place of the database password.
 *
 * Connection: postgres.{ref}:{service_role_key}@aws-0-{region}.pooler.supabase.com:5432/postgres
 */

import { readFileSync } from "fs";
import { createConnection } from "net";
import pkg from "pg";
const { Client } = pkg;

const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUP_URL  = process.env.SUPABASE_URL ?? "https://onxdcikfttdmnhofsuwo.supabase.co";
const TARGET   = process.env.MIGRATION_TARGET ?? "all";

// Extract project ref from URL
const ref = new URL(SUP_URL).hostname.split(".")[0]; // onxdcikfttdmnhofsuwo

// Try regions in order of likelihood (West Africa project → EU or US regions)
const POOLER_REGIONS = [
  "aws-0-eu-central-1",
  "aws-0-us-east-1",
  "aws-0-us-west-1",
  "aws-0-ap-southeast-1",
];

async function connect(host) {
  const client = new Client({
    host,
    port: 5432,
    database: "postgres",
    user: `postgres.${ref}`,
    password: SVC_KEY,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

async function tryConnect() {
  // 1. Try session-mode pooler (JWT auth) across known regions
  for (const region of POOLER_REGIONS) {
    const host = `${region}.pooler.supabase.com`;
    try {
      console.log(`  → Trying ${host}…`);
      const client = await connect(host);
      console.log(`  ✅  Connected via ${host}`);
      return client;
    } catch (e) {
      console.log(`  ✗  ${host}: ${e.message}`);
    }
  }

  // 2. Fallback: direct DB host (requires database password, not JWT)
  const directHost = `db.${ref}.supabase.co`;
  try {
    console.log(`  → Trying direct ${directHost}…`);
    const client = new Client({
      host: directHost,
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: SVC_KEY,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    console.log(`  ✅  Connected via ${directHost}`);
    return client;
  } catch (e) {
    console.log(`  ✗  ${directHost}: ${e.message}`);
  }

  throw new Error(
    `All connection attempts failed.\n` +
    `Add SUPABASE_DB_PASSWORD to org secrets (Project Settings → Database → Connection string password in Supabase dashboard),\n` +
    `then update this script to use: user=postgres, password=SUPABASE_DB_PASSWORD, host=db.${ref}.supabase.co`
  );
}

async function runSql(client, label, sql) {
  console.log(`\n── ${label} ──`);
  // Split on semicolons but keep statement context (triggers use $$...$$)
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let ok = 0, skip = 0, fail = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt + ";");
      ok++;
    } catch (e) {
      if (e.message.includes("already exists") || e.message.includes("duplicate")) {
        skip++;
      } else {
        console.error(`  ⚠  ${e.message.slice(0, 120)}`);
        fail++;
      }
    }
  }
  console.log(`  ✅  ${label}: ${ok} ok, ${skip} skipped (already exist), ${fail} errors`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🗄  Supabase migration — project: ${ref}`);
console.log(`   Target: ${TARGET}\n`);

let client;
try {
  client = await tryConnect();
} catch (e) {
  console.error("\n❌  " + e.message);
  process.exit(1);
}

try {
  if (TARGET === "all" || TARGET === "payrald-schema") {
    const sql = readFileSync("supabase-schema.sql", "utf8");
    await runSql(client, "payrald-schema (wallets, transactions, transfers, merchants…)", sql);
  }

  if (TARGET === "all" || TARGET === "waitlist") {
    const waitlistSql = `
CREATE TABLE IF NOT EXISTS public.waitlist (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT        NOT NULL,
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT waitlist_email_unique UNIQUE (email)
);

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public_join_waitlist" ON public.waitlist
    FOR INSERT TO anon, authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "public_read_count" ON public.waitlist
    FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;
    await runSql(client, "waitlist (ALIA private beta)", waitlistSql);
  }

  console.log("\n✅  All migrations complete.\n");
} finally {
  await client.end();
}
