// RALD PayRald Core — Supabase typed helpers for payrald_* tables
// All operations use service role key (bypasses RLS — workers are trusted).
// LILCKY STUDIO LIMITED

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getDb(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Wallet ──────────────────────────────────────────────────────────────────

export interface Wallet {
  id: string; user_id: string; wallet_type: string;
  total_balance: number; available_balance: number; pending_balance: number;
  currency: string; virtual_account_number: string | null;
  virtual_account_bank: string | null; virtual_account_ref: string | null;
  kyc_tier: number; trust_score: number; is_frozen: boolean;
  freeze_reason: string | null; daily_limit: number; daily_used: number;
  daily_reset_at: string | null; last_activity_at: string | null;
  created_at: string; updated_at: string;
}

export async function getWallet(db: SupabaseClient, userId: string): Promise<Wallet | null> {
  const { data, error } = await db.from("payrald_wallets").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as Wallet | null;
}

export async function getOrCreateWallet(db: SupabaseClient, userId: string): Promise<Wallet> {
  const existing = await getWallet(db, userId);
  if (existing) return existing;
  const { data, error } = await db
    .from("payrald_wallets")
    .insert({ user_id: userId, wallet_type: "Personal", total_balance: 0, available_balance: 0, pending_balance: 0, currency: "NGN", kyc_tier: 1, trust_score: 0, is_frozen: false, daily_limit: 200000, daily_used: 0 })
    .select()
    .single();
  if (error) throw error;
  return data as Wallet;
}

export async function debitWallet(db: SupabaseClient, userId: string, amount: number): Promise<Wallet> {
  const w = await getWallet(db, userId);
  if (!w)              throw Object.assign(new Error("Wallet not found"),          { code: "WALLET_NOT_FOUND" });
  if (w.is_frozen)     throw Object.assign(new Error(w.freeze_reason ?? "Frozen"), { code: "WALLET_FROZEN" });
  if (w.available_balance < amount) throw Object.assign(new Error("Insufficient balance"), { code: "INSUFFICIENT_BALANCE" });

  const { data, error } = await db
    .from("payrald_wallets")
    .update({ available_balance: w.available_balance - amount, total_balance: w.total_balance - amount, last_activity_at: new Date().toISOString() })
    .eq("user_id", userId).select().single();
  if (error) throw error;
  return data as Wallet;
}

export async function creditWallet(db: SupabaseClient, userId: string, amount: number): Promise<Wallet> {
  const w = await getOrCreateWallet(db, userId);
  const { data, error } = await db
    .from("payrald_wallets")
    .update({ available_balance: w.available_balance + amount, total_balance: w.total_balance + amount, last_activity_at: new Date().toISOString() })
    .eq("user_id", userId).select().single();
  if (error) throw error;
  return data as Wallet;
}

export async function reverseDebit(db: SupabaseClient, userId: string, amount: number): Promise<void> {
  await creditWallet(db, userId, amount);
}

// ── Transactions ────────────────────────────────────────────────────────────

export interface TransactionInsert {
  user_id: string; type: string; direction: string; amount: number;
  fee?: number; currency?: string; status?: string; provider?: string;
  provider_ref?: string; alia_token?: string; recipient_alias?: string;
  recipient_name?: string; recipient_bank?: string; recipient_bank_code?: string;
  narration?: string; metadata?: Record<string, unknown>;
}

export async function createTransaction(db: SupabaseClient, d: TransactionInsert) {
  const { data, error } = await db.from("payrald_transactions").insert({
    user_id: d.user_id, type: d.type, direction: d.direction, amount: d.amount,
    fee: d.fee ?? 0, currency: d.currency ?? "NGN", status: d.status ?? "pending",
    provider: d.provider ?? "squad", provider_ref: d.provider_ref ?? null,
    alia_token: d.alia_token ?? null, recipient_alias: d.recipient_alias ?? null,
    recipient_name: d.recipient_name ?? null, recipient_bank: d.recipient_bank ?? null,
    recipient_bank_code: d.recipient_bank_code ?? null,
    narration: d.narration ?? null, metadata: d.metadata ?? {},
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updateTransactionStatus(
  db: SupabaseClient, id: string, status: string, providerRef?: string
) {
  const { error } = await db.from("payrald_transactions")
    .update({ status, ...(providerRef ? { provider_ref: providerRef } : {}) })
    .eq("id", id);
  if (error) throw error;
}

export async function updateByProviderRef(
  db: SupabaseClient, table: string, providerRef: string, status: string
) {
  const { error } = await db.from(table).update({ status }).eq("provider_ref", providerRef);
  if (error) throw error;
}
