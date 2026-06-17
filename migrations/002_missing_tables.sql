-- PayRald Migration 002 — Missing tables for beta readiness
-- Run against: onxdcikfttdmnhofsuwo.supabase.co
-- Date: 2026-06-17
-- LILCKY STUDIO LIMITED

-- ── OTP Codes ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,
  identifier   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('signin','verify_email','verify_phone','reset_pin','withdraw')),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_identifier ON otp_codes(identifier);
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires    ON otp_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_codes_user       ON otp_codes(user_id);

ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "otp_codes: service_role only"
  ON otp_codes FOR ALL USING (true) WITH CHECK (true);

-- Auto-expire: delete OTPs older than 24h
CREATE OR REPLACE FUNCTION purge_expired_otps() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM otp_codes WHERE expires_at < now() - INTERVAL '24 hours';
END;
$$;

-- ── User Devices ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  device_id      TEXT NOT NULL,
  device_name    TEXT,
  platform       TEXT CHECK (platform IN ('ios','android','web','unknown')),
  push_token     TEXT,
  fingerprint    TEXT,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  trusted        BOOLEAN NOT NULL DEFAULT false,
  trusted_at     TIMESTAMPTZ,
  revoked        BOOLEAN NOT NULL DEFAULT false,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_uid_did ON user_devices(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_user         ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_push_token   ON user_devices(push_token) WHERE push_token IS NOT NULL;

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_devices: service_role only"
  ON user_devices FOR ALL USING (true) WITH CHECK (true);

-- ── Product Access ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  product      TEXT NOT NULL CHECK (product IN ('payrald','loop','messenger','elimu','alia','rald_os')),
  plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','basic','pro','enterprise')),
  granted_by   TEXT NOT NULL DEFAULT 'signup',
  active       BOOLEAN NOT NULL DEFAULT true,
  expires_at   TIMESTAMPTZ,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_access_user_product ON product_access(user_id, product);
CREATE INDEX IF NOT EXISTS idx_product_access_user    ON product_access(user_id);
CREATE INDEX IF NOT EXISTS idx_product_access_product ON product_access(product);

ALTER TABLE product_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_access: service_role only"
  ON product_access FOR ALL USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_product_access_updated ON product_access;
CREATE TRIGGER trg_product_access_updated BEFORE UPDATE ON product_access
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── PayRald Voucher Products ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payrald_voucher_products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL DEFAULT 'general',
  price_ngn        NUMERIC(15,2) NOT NULL CHECK (price_ngn > 0),
  original_price   NUMERIC(15,2),
  discount_pct     NUMERIC(5,2) DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  stock_unlimited  BOOLEAN NOT NULL DEFAULT true,
  stock_count      INTEGER CHECK (stock_count >= 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  valid_days       INTEGER NOT NULL DEFAULT 365,
  terms            TEXT,
  image_url        TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voucher_products_merchant  ON payrald_voucher_products(merchant_id);
CREATE INDEX IF NOT EXISTS idx_voucher_products_category  ON payrald_voucher_products(category);
CREATE INDEX IF NOT EXISTS idx_voucher_products_active    ON payrald_voucher_products(active);

ALTER TABLE payrald_voucher_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voucher_products: service_role only"
  ON payrald_voucher_products FOR ALL USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_voucher_products_updated ON payrald_voucher_products;
CREATE TRIGGER trg_voucher_products_updated BEFORE UPDATE ON payrald_voucher_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Wallet auto-provisioning trigger ──────────────────────────────────────────
-- When a new user record is inserted into payrald_users (or any identity store),
-- auto-create a wallet. Adjust table name if user table is named differently.
CREATE OR REPLACE FUNCTION auto_provision_wallet()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payrald_wallets (user_id, wallet_type, currency, kyc_tier)
  VALUES (NEW.id, 'Personal', 'NGN', 1)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO product_access (user_id, product, plan, granted_by)
  VALUES (NEW.id, 'payrald', 'free', 'signup')
  ON CONFLICT (user_id, product) DO NOTHING;

  RETURN NEW;
END;
$$;
