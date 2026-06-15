-- RALD PayRald — Authoritative Supabase schema v1.1.0
-- Run once against the shared Supabase instance (onxdcikfttdmnhofsuwo.supabase.co).
-- All payrald_* tables are owned by payrald-core and shared across payrald-api, payrald-wallet.
-- LILCKY STUDIO LIMITED

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── updated_at trigger helper ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Wallets ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_wallets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL UNIQUE,
  wallet_type            TEXT NOT NULL DEFAULT 'Personal',
  total_balance          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_balance >= 0),
  available_balance      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  pending_balance        NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (pending_balance >= 0),
  currency               TEXT NOT NULL DEFAULT 'NGN',
  virtual_account_number TEXT,
  virtual_account_bank   TEXT,
  virtual_account_ref    TEXT,
  squad_virtual_ref      TEXT,
  kyc_tier               INTEGER NOT NULL DEFAULT 1 CHECK (kyc_tier BETWEEN 1 AND 3),
  trust_score            NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_frozen              BOOLEAN NOT NULL DEFAULT false,
  freeze_reason          TEXT,
  daily_limit            NUMERIC(15,2) NOT NULL DEFAULT 200000,
  daily_used             NUMERIC(15,2) NOT NULL DEFAULT 0,
  daily_reset_at         TIMESTAMPTZ,
  last_activity_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_wallets_user   ON payrald_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_wallets_va_num ON payrald_wallets(virtual_account_number);
DROP TRIGGER IF EXISTS trg_payrald_wallets_updated ON payrald_wallets;
CREATE TRIGGER trg_payrald_wallets_updated BEFORE UPDATE ON payrald_wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Wallet events (audit ledger) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_wallet_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   UUID NOT NULL,
  user_id     UUID NOT NULL,
  event_type  TEXT NOT NULL,
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  balance_before NUMERIC(15,2) NOT NULL DEFAULT 0,
  balance_after  NUMERIC(15,2) NOT NULL DEFAULT 0,
  reference   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_wallet_events_wallet ON payrald_wallet_events(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payrald_wallet_events_user   ON payrald_wallet_events(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_wallet_events_type   ON payrald_wallet_events(event_type);
CREATE INDEX IF NOT EXISTS idx_payrald_wallet_events_ts     ON payrald_wallet_events(created_at DESC);

-- ── Wallet reservations (pending holds) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_wallet_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   UUID NOT NULL,
  user_id     UUID NOT NULL,
  amount      NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason      TEXT NOT NULL,
  reference   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed','expired')),
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_reservations_wallet ON payrald_wallet_reservations(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payrald_reservations_status ON payrald_wallet_reservations(status);
DROP TRIGGER IF EXISTS trg_payrald_reservations_updated ON payrald_wallet_reservations;
CREATE TRIGGER trg_payrald_reservations_updated BEFORE UPDATE ON payrald_wallet_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Wallet limits ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_wallet_limits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_tier          INTEGER NOT NULL UNIQUE CHECK (kyc_tier BETWEEN 1 AND 3),
  daily_send_limit  NUMERIC(15,2) NOT NULL,
  daily_recv_limit  NUMERIC(15,2) NOT NULL,
  single_tx_limit   NUMERIC(15,2) NOT NULL,
  monthly_limit     NUMERIC(15,2) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payrald_wallet_limits (kyc_tier, daily_send_limit, daily_recv_limit, single_tx_limit, monthly_limit) VALUES
  (1,  50000,   200000,   50000,   200000),
  (2,  500000,  1000000,  200000,  2000000),
  (3,  5000000, 10000000, 2000000, 20000000)
ON CONFLICT (kyc_tier) DO NOTHING;

-- ── Core transaction ledger ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('transfer','withdrawal','payment','top_up','refund','fee','reversal','voucher')),
  direction            TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount               NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  fee                  NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  currency             TEXT NOT NULL DEFAULT 'NGN',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','reversed','cancelled')),
  provider             TEXT NOT NULL DEFAULT 'squad',
  provider_ref         TEXT,
  squad_ref            TEXT,
  alia_token           TEXT,
  recipient_alias      TEXT,
  recipient_name       TEXT,
  recipient_bank       TEXT,
  recipient_bank_code  TEXT,
  narration            TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_tx_user         ON payrald_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_tx_status       ON payrald_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payrald_tx_provider_ref ON payrald_transactions(provider_ref);
CREATE INDEX IF NOT EXISTS idx_payrald_tx_type         ON payrald_transactions(type);
CREATE INDEX IF NOT EXISTS idx_payrald_tx_created      ON payrald_transactions(created_at DESC);
DROP TRIGGER IF EXISTS trg_payrald_tx_updated ON payrald_transactions;
CREATE TRIGGER trg_payrald_tx_updated BEFORE UPDATE ON payrald_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Transfers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_transfers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL,
  recipient_alias      TEXT NOT NULL,
  recipient_name       TEXT,
  recipient_bank_code  TEXT,
  recipient_bank_name  TEXT,
  alia_token           TEXT,
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fee                  NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'NGN',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','reversed','cancelled')),
  provider             TEXT NOT NULL DEFAULT 'squad',
  provider_ref         TEXT,
  transfer_type        TEXT NOT NULL DEFAULT 'external' CHECK (transfer_type IN ('external','internal','rald_to_rald')),
  wallet_type          TEXT NOT NULL DEFAULT 'Personal',
  narration            TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_transfers_user         ON payrald_transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_transfers_status       ON payrald_transfers(status);
CREATE INDEX IF NOT EXISTS idx_payrald_transfers_provider_ref ON payrald_transfers(provider_ref);
CREATE INDEX IF NOT EXISTS idx_payrald_transfers_created      ON payrald_transfers(created_at DESC);
DROP TRIGGER IF EXISTS trg_payrald_transfers_updated ON payrald_transfers;
CREATE TRIGGER trg_payrald_transfers_updated BEFORE UPDATE ON payrald_transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Withdrawals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_withdrawals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  bank_code       TEXT NOT NULL,
  bank_name       TEXT,
  account_number  TEXT NOT NULL,
  account_name    TEXT NOT NULL,
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fee             NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'NGN',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','reversed','cancelled')),
  provider        TEXT NOT NULL DEFAULT 'squad',
  provider_ref    TEXT,
  narration       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_withdrawals_user         ON payrald_withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_withdrawals_status       ON payrald_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_payrald_withdrawals_provider_ref ON payrald_withdrawals(provider_ref);
DROP TRIGGER IF EXISTS trg_payrald_withdrawals_updated ON payrald_withdrawals;
CREATE TRIGGER trg_payrald_withdrawals_updated BEFORE UPDATE ON payrald_withdrawals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Merchant profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_merchant_profiles (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_alias       TEXT NOT NULL UNIQUE,
  merchant_type        TEXT NOT NULL CHECK (merchant_type IN ('Digital','Business','Educational','Creator','Government','Marketplace')),
  display_name         TEXT NOT NULL,
  description          TEXT,
  logo_url             TEXT,
  category             TEXT NOT NULL DEFAULT 'general',
  country              TEXT NOT NULL DEFAULT 'NG',
  supported_currencies TEXT[] NOT NULL DEFAULT '{NGN}',
  supported_products   TEXT[] NOT NULL DEFAULT '{}',
  trust_score          NUMERIC(5,2) NOT NULL DEFAULT 0,
  compliance_status    TEXT NOT NULL DEFAULT 'pending' CHECK (compliance_status IN ('pending','approved','suspended','rejected')),
  settlement_wallet_id UUID,
  settlement_bank_code TEXT,
  settlement_account   TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  is_verified          BOOLEAN NOT NULL DEFAULT false,
  alia_merchant_id     TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_merchants_alias  ON payrald_merchant_profiles(merchant_alias);
CREATE INDEX IF NOT EXISTS idx_payrald_merchants_type   ON payrald_merchant_profiles(merchant_type);
CREATE INDEX IF NOT EXISTS idx_payrald_merchants_active ON payrald_merchant_profiles(is_active);
DROP TRIGGER IF EXISTS trg_payrald_merchants_updated ON payrald_merchant_profiles;
CREATE TRIGGER trg_payrald_merchants_updated BEFORE UPDATE ON payrald_merchant_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Merchant payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  merchant_alias    TEXT NOT NULL,
  merchant_name     TEXT NOT NULL,
  merchant_type     TEXT,
  amount            NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fee               NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'NGN',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','reversed','cancelled')),
  provider          TEXT NOT NULL DEFAULT 'internal',
  provider_ref      TEXT,
  alia_token        TEXT,
  narration         TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_payments_user     ON payrald_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_payments_merchant ON payrald_payments(merchant_alias);
CREATE INDEX IF NOT EXISTS idx_payrald_payments_status   ON payrald_payments(status);
CREATE INDEX IF NOT EXISTS idx_payrald_payments_created  ON payrald_payments(created_at DESC);
DROP TRIGGER IF EXISTS trg_payrald_payments_updated ON payrald_payments;
CREATE TRIGGER trg_payrald_payments_updated BEFORE UPDATE ON payrald_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Voucher products (catalog) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_voucher_products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('streaming','gaming','cloud','creative','ai','education','shopping','other')),
  description     TEXT,
  logo_url        TEXT,
  price_ngn       NUMERIC(15,2) NOT NULL,
  face_value      TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'NGN',
  delivery_type   TEXT NOT NULL DEFAULT 'code' CHECK (delivery_type IN ('code','link','pin')),
  instructions    TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  in_stock        BOOLEAN NOT NULL DEFAULT true,
  stock_count     INTEGER NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_products_slug     ON payrald_voucher_products(slug);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_products_category ON payrald_voucher_products(category);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_products_active   ON payrald_voucher_products(is_active);
DROP TRIGGER IF EXISTS trg_payrald_voucher_products_updated ON payrald_voucher_products;
CREATE TRIGGER trg_payrald_voucher_products_updated BEFORE UPDATE ON payrald_voucher_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed voucher catalog
INSERT INTO payrald_voucher_products (name, slug, provider, category, description, price_ngn, face_value, delivery_type, instructions, is_active, in_stock) VALUES
  ('Spotify Premium 1 Month',    'spotify-1m',       'Spotify',    'streaming', '1 month of Spotify Premium. Access millions of songs ad-free.',    2500,  '1 Month',   'code', 'Redeem at spotify.com/redeem', true, false),
  ('Spotify Premium 3 Months',   'spotify-3m',       'Spotify',    'streaming', '3 months of Spotify Premium.',                                      7000,  '3 Months',  'code', 'Redeem at spotify.com/redeem', true, false),
  ('Netflix Standard 1 Month',   'netflix-standard', 'Netflix',    'streaming', '1 month of Netflix Standard (1080p, 2 screens).',                   5500,  '1 Month',   'code', 'Redeem at netflix.com/redeem', true, false),
  ('Netflix Premium 1 Month',    'netflix-premium',  'Netflix',    'streaming', '1 month of Netflix Premium (4K, 4 screens).',                       8000,  '1 Month',   'code', 'Redeem at netflix.com/redeem', true, false),
  ('Google Play ₦2000',          'google-play-2k',   'Google',     'shopping',  'Google Play gift card — apps, games, subscriptions.',               2200,  '₦2000',     'code', 'Redeem in Google Play app > Payment > Redeem', true, false),
  ('Google Play ₦5000',          'google-play-5k',   'Google',     'shopping',  'Google Play gift card.',                                            5500,  '₦5000',     'code', 'Redeem in Google Play app > Payment > Redeem', true, false),
  ('Apple Gift Card ₦5000',      'apple-5k',         'Apple',      'shopping',  'Apple Gift Card — App Store, Apple Music, iCloud, and more.',       5500,  '₦5000',     'code', 'Redeem in App Store > your account > Redeem Gift Card', true, false),
  ('Steam Wallet ₦5000',         'steam-5k',         'Steam',      'gaming',    'Steam Wallet Code — games and in-game content.',                    5500,  '₦5000',     'code', 'Redeem in Steam > Account > Add funds', true, false),
  ('PlayStation Store ₦5000',    'psn-5k',           'PlayStation','gaming',    'PlayStation Network gift card — games and subscriptions.',           5700,  '₦5000',     'code', 'Redeem on PlayStation Store', true, false),
  ('Xbox Game Pass 1 Month',     'xbox-gamepass-1m', 'Xbox',       'gaming',    '1 month Xbox Game Pass Ultimate — 100+ games.',                     5000,  '1 Month',   'code', 'Redeem at microsoft.com/redeem', true, false),
  ('Amazon Gift Card ₦5000',     'amazon-5k',        'Amazon',     'shopping',  'Amazon.co.uk Gift Card.',                                           5800,  '₦5000',     'code', 'Redeem at amazon.co.uk/gc', true, false),
  ('ChatGPT Plus 1 Month',       'chatgpt-plus-1m',  'OpenAI',     'ai',        '1 month ChatGPT Plus — GPT-4, faster responses.',                   16000, '1 Month',   'code', 'Redeem at chat.openai.com > Upgrade plan', true, false),
  ('Canva Pro 1 Month',          'canva-pro-1m',     'Canva',      'creative',  '1 month Canva Pro — premium templates, brand kit, 100GB storage.', 7500,  '1 Month',   'code', 'Redeem at canva.com/upgrade', true, false),
  ('Adobe Creative Cloud 1 Mo',  'adobe-cc-1m',      'Adobe',      'creative',  '1 month Adobe Creative Cloud — all apps.',                          50000, '1 Month',   'code', 'Redeem at adobe.com/redeem', true, false),
  ('Microsoft 365 Personal',     'ms365-1m',         'Microsoft',  'cloud',     '1 month Microsoft 365 Personal — Office + 1TB OneDrive.',           5000,  '1 Month',   'code', 'Redeem at microsoft.com/redeem', true, false)
ON CONFLICT (slug) DO NOTHING;

-- ── Voucher inventory ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_voucher_inventory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES payrald_voucher_products(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  pin         TEXT,
  face_value  TEXT NOT NULL,
  is_sold     BOOLEAN NOT NULL DEFAULT false,
  sold_to     UUID,
  sold_at     TIMESTAMPTZ,
  purchase_id UUID,
  batch_ref   TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_inventory_product ON payrald_voucher_inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_payrald_inventory_sold    ON payrald_voucher_inventory(is_sold);

-- ── Voucher purchases ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_voucher_purchases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  product_id    UUID NOT NULL,
  product_slug  TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  inventory_id  UUID REFERENCES payrald_voucher_inventory(id),
  amount_paid   NUMERIC(15,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'NGN',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  code_revealed BOOLEAN NOT NULL DEFAULT false,
  delivered_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_purchases_user    ON payrald_voucher_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_purchases_product ON payrald_voucher_purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_purchases_status  ON payrald_voucher_purchases(status);
CREATE INDEX IF NOT EXISTS idx_payrald_voucher_purchases_created ON payrald_voucher_purchases(created_at DESC);
DROP TRIGGER IF EXISTS trg_payrald_voucher_purchases_updated ON payrald_voucher_purchases;
CREATE TRIGGER trg_payrald_voucher_purchases_updated BEFORE UPDATE ON payrald_voucher_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Settlements ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_settlements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_type   TEXT NOT NULL CHECK (settlement_type IN ('merchant','withdrawal','refund','batch')),
  merchant_alias    TEXT,
  user_id           UUID,
  amount            NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fee               NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'NGN',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  provider          TEXT NOT NULL DEFAULT 'squad',
  provider_ref      TEXT,
  batch_id          UUID,
  source_ref        UUID,
  narration         TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_settlements_type    ON payrald_settlements(settlement_type);
CREATE INDEX IF NOT EXISTS idx_payrald_settlements_status  ON payrald_settlements(status);
CREATE INDEX IF NOT EXISTS idx_payrald_settlements_merchant ON payrald_settlements(merchant_alias);
CREATE INDEX IF NOT EXISTS idx_payrald_settlements_created ON payrald_settlements(created_at DESC);
DROP TRIGGER IF EXISTS trg_payrald_settlements_updated ON payrald_settlements;
CREATE TRIGGER trg_payrald_settlements_updated BEFORE UPDATE ON payrald_settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Settlement batches ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_settlement_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_ref       TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','completed','failed')),
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_fee       NUMERIC(15,2) NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,
  processed_at    TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_payrald_batches_updated ON payrald_settlement_batches;
CREATE TRIGGER trg_payrald_batches_updated BEFORE UPDATE ON payrald_settlement_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Risk flags ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_risk_flags (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  flag_type     TEXT NOT NULL CHECK (flag_type IN ('velocity','amount','pattern','device','manual')),
  severity      TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  description   TEXT NOT NULL,
  reference_id  UUID,
  reference_type TEXT,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  resolved_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_risk_user     ON payrald_risk_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_payrald_risk_severity ON payrald_risk_flags(severity);
CREATE INDEX IF NOT EXISTS idx_payrald_risk_resolved ON payrald_risk_flags(resolved);

-- ── Routing profiles (ALIA cached resolution data) ────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_routing_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_value       TEXT NOT NULL UNIQUE,
  alias_type        TEXT NOT NULL,
  entity_type       TEXT NOT NULL DEFAULT 'user' CHECK (entity_type IN ('user','merchant','business','institution')),
  institution_id    TEXT,
  institution_name  TEXT,
  institution_type  TEXT,
  display_name      TEXT,
  alia_token        TEXT,
  token_expires_at  TIMESTAMPTZ,
  is_internal       BOOLEAN NOT NULL DEFAULT false,
  verified          BOOLEAN NOT NULL DEFAULT false,
  last_resolved_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_routing_alias ON payrald_routing_profiles(alias_value);
CREATE INDEX IF NOT EXISTS idx_payrald_routing_type  ON payrald_routing_profiles(entity_type);
DROP TRIGGER IF EXISTS trg_payrald_routing_updated ON payrald_routing_profiles;
CREATE TRIGGER trg_payrald_routing_updated BEFORE UPDATE ON payrald_routing_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Webhook events log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL DEFAULT 'squad',
  event_type   TEXT NOT NULL,
  event_ref    TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed    BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrald_webhook_ref       ON payrald_webhook_events(event_ref);
CREATE INDEX IF NOT EXISTS idx_payrald_webhook_processed ON payrald_webhook_events(processed);
CREATE INDEX IF NOT EXISTS idx_payrald_webhook_type      ON payrald_webhook_events(event_type);

-- ── Banks reference ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_banks (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  supported  BOOLEAN NOT NULL DEFAULT true,
  active     BOOLEAN NOT NULL DEFAULT true
);

-- ── Alias registrations (PayRald users register their aliases here) ────────────
CREATE TABLE IF NOT EXISTS payrald_aliases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  alias_type    TEXT NOT NULL CHECK (alias_type IN ('email','phone','username','handle')),
  alias_value   TEXT NOT NULL,
  alia_alias_id TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payrald_aliases_value ON payrald_aliases(alias_value);
CREATE INDEX IF NOT EXISTS idx_payrald_aliases_user         ON payrald_aliases(user_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE payrald_wallets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_wallet_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_wallet_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_transfers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_withdrawals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_voucher_purchases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_aliases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_risk_flags          ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "wallets_owner"             ON payrald_wallets             FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "wallet_events_owner"       ON payrald_wallet_events       FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "reservations_owner"        ON payrald_wallet_reservations FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "transactions_owner"        ON payrald_transactions        FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "transfers_owner"           ON payrald_transfers           FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "withdrawals_owner"         ON payrald_withdrawals         FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "payments_owner"            ON payrald_payments            FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "voucher_purchases_owner"   ON payrald_voucher_purchases   FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "aliases_owner"             ON payrald_aliases             FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "risk_flags_owner"          ON payrald_risk_flags          FOR ALL USING (auth.uid()::text = user_id::text);

ALTER TABLE payrald_banks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_voucher_products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_merchant_profiles  ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "banks_public_read"     ON payrald_banks            FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "vouchers_public_read"  ON payrald_voucher_products FOR SELECT USING (is_active = true);
CREATE POLICY IF NOT EXISTS "merchants_public_read" ON payrald_merchant_profiles FOR SELECT USING (is_active = true AND compliance_status = 'approved');

-- ── Seed Nigerian banks ────────────────────────────────────────────────────────
INSERT INTO payrald_banks (code, name, short_name) VALUES
('044','Access Bank','Access'),('063','Access Bank (Diamond)','Diamond'),
('035A','ALAT by Wema','ALAT'),('401','ASO Savings and Loans','ASO'),
('023','Citibank Nigeria','Citibank'),('050','EcoBank Nigeria','EcoBank'),
('562','Ekondo Microfinance Bank','Ekondo'),('084','Enterprise Bank','Enterprise'),
('070','Fidelity Bank','Fidelity'),('011','First Bank of Nigeria','First Bank'),
('214','First City Monument Bank','FCMB'),('058','Guaranty Trust Bank','GTBank'),
('030','Heritage Bank','Heritage'),('301','Jaiz Bank','Jaiz'),
('082','Keystone Bank','Keystone'),('503','Kuda Bank','Kuda'),
('526','Moniepoint MFB','Moniepoint'),('014','Mainstreet Bank','Mainstreet'),
('090175','MoMo PSB','MoMo'),('076','Polaris Bank','Polaris'),
('101','Providus Bank','Providus'),('221','Stanbic IBTC Bank','Stanbic'),
('068','Standard Chartered Bank','Std Chartered'),('232','Sterling Bank','Sterling'),
('100','Suntrust Bank','Suntrust'),('032','Union Bank of Nigeria','Union Bank'),
('033','United Bank for Africa','UBA'),('215','Unity Bank','Unity'),
('035','Wema Bank','Wema'),('057','Zenith Bank','Zenith'),
('999240','Opay','OPay'),('999992','PalmPay','PalmPay'),
('090267','Kuda MFB','Kuda'),('50515','Carbon','Carbon'),
('949','Sparkle MFB','Sparkle'),('110','VFD MFB','VFD'),
('565','Carbon MFB','Carbon'),('090281','Eyowo','Eyowo'),
('100033','PagaTech','Paga'),('000036','Paycom (OPay)','OPay'),
('090405','Taj Bank','Taj'),('000014','Zenith Bank Mobile','Zenith Mobile')
ON CONFLICT (code) DO NOTHING;

-- ── Seed global merchants ──────────────────────────────────────────────────────
INSERT INTO payrald_merchant_profiles (merchant_alias, merchant_type, display_name, category, country, supported_currencies, supported_products, trust_score, compliance_status, is_active, is_verified) VALUES
('@spotify',    'Digital',      'Spotify',              'streaming', 'SE', '{NGN,USD}', '{subscription,premium}',     100, 'approved', true, true),
('@netflix',    'Digital',      'Netflix',              'streaming', 'US', '{NGN,USD}', '{subscription,premium}',     100, 'approved', true, true),
('@openai',     'Digital',      'OpenAI',               'ai',        'US', '{NGN,USD}', '{chatgpt_plus,api_credits}',  100, 'approved', true, true),
('@canva',      'Digital',      'Canva',                'creative',  'AU', '{NGN,USD}', '{pro,team}',                  100, 'approved', true, true),
('@adobe',      'Digital',      'Adobe',                'creative',  'US', '{NGN,USD}', '{creative_cloud,stock}',      100, 'approved', true, true),
('@apple',      'Digital',      'Apple',                'shopping',  'US', '{NGN,USD}', '{app_store,music,icloud}',   100, 'approved', true, true),
('@google',     'Digital',      'Google',               'cloud',     'US', '{NGN,USD}', '{play_store,workspace}',      100, 'approved', true, true),
('@microsoft',  'Digital',      'Microsoft',            'cloud',     'US', '{NGN,USD}', '{365,azure,xbox}',            100, 'approved', true, true),
('@steam',      'Digital',      'Steam',                'gaming',    'US', '{NGN,USD}', '{games,wallet}',              100, 'approved', true, true),
('@amazon',     'Digital',      'Amazon',               'shopping',  'US', '{NGN,USD}', '{gift_card,prime}',           100, 'approved', true, true)
ON CONFLICT (merchant_alias) DO NOTHING;
