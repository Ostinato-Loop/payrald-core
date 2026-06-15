-- RALD PayRald — Authoritative Supabase schema
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

-- ── Core transaction ledger ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('transfer','withdrawal','payment','top_up','refund','fee','reversal')),
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
-- Links a RALD user to their ALIA-registered aliases for receiving payments.
CREATE TABLE IF NOT EXISTS payrald_aliases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  alias_type   TEXT NOT NULL CHECK (alias_type IN ('email','phone','username','handle')),
  alias_value  TEXT NOT NULL,
  alia_alias_id TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payrald_aliases_value  ON payrald_aliases(alias_value);
CREATE INDEX IF NOT EXISTS idx_payrald_aliases_user         ON payrald_aliases(user_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Workers use service role key (bypasses RLS).
-- These policies protect direct anon/user key access.
ALTER TABLE payrald_wallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_transfers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_withdrawals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payrald_aliases       ENABLE ROW LEVEL SECURITY;

-- Service role bypasses all RLS — policies below guard anon access only
CREATE POLICY IF NOT EXISTS "wallets_owner"      ON payrald_wallets      FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "transactions_owner" ON payrald_transactions FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "transfers_owner"    ON payrald_transfers    FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "withdrawals_owner"  ON payrald_withdrawals  FOR ALL USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "aliases_owner"      ON payrald_aliases      FOR ALL USING (auth.uid()::text = user_id::text);

-- Banks are public read
ALTER TABLE payrald_banks ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "banks_public_read" ON payrald_banks FOR SELECT USING (true);

-- ── Seed Nigerian banks ────────────────────────────────────────────────────────
INSERT INTO payrald_banks (code, name, short_name) VALUES
('044','Access Bank','Access'),
('063','Access Bank (Diamond)','Diamond'),
('035A','ALAT by Wema','ALAT'),
('401','ASO Savings and Loans','ASO'),
('023','Citibank Nigeria','Citibank'),
('050','EcoBank Nigeria','EcoBank'),
('562','Ekondo Microfinance Bank','Ekondo'),
('084','Enterprise Bank','Enterprise'),
('070','Fidelity Bank','Fidelity'),
('011','First Bank of Nigeria','First Bank'),
('214','First City Monument Bank','FCMB'),
('058','Guaranty Trust Bank','GTBank'),
('030','Heritage Bank','Heritage'),
('301','Jaiz Bank','Jaiz'),
('082','Keystone Bank','Keystone'),
('503','Kuda Bank','Kuda'),
('526','Moniepoint MFB','Moniepoint'),
('014','Mainstreet Bank','Mainstreet'),
('090175','MoMo PSB','MoMo'),
('076','Polaris Bank','Polaris'),
('101','Providus Bank','Providus'),
('221','Stanbic IBTC Bank','Stanbic'),
('068','Standard Chartered Bank','Std Chartered'),
('232','Sterling Bank','Sterling'),
('100','Suntrust Bank','Suntrust'),
('032','Union Bank of Nigeria','Union Bank'),
('033','United Bank for Africa','UBA'),
('215','Unity Bank','Unity'),
('035','Wema Bank','Wema'),
('057','Zenith Bank','Zenith'),
('999240','Opay','OPay'),
('999992','PalmPay','PalmPay'),
('090267','Kuda MFB','Kuda'),
('50515','Carbon','Carbon'),
('949','Sparkle MFB','Sparkle'),
('110','VFD MFB','VFD'),
('565','Carbon MFB','Carbon'),
('090281','Eyowo','Eyowo'),
('100033','PagaTech','Paga'),
('000036','Paycom (OPay)','OPay'),
('090405','Taj Bank','Taj'),
('000014','Zenith Bank Mobile','Zenith Mobile')
ON CONFLICT (code) DO NOTHING;
