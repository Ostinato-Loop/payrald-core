-- PayRald — Missing Tables Migration v1.0.0
-- Sprint: RALD Stabilization · 2026-06-17
-- Adds: otp_codes, user_devices, product_access, payrald_voucher_products
-- Run against: onxdcikfttdmnhofsuwo.supabase.co
-- LILCKY STUDIO LIMITED

-- ── OTP Codes ─────────────────────────────────────────────────────────────────
-- Short-lived one-time passwords for phone/email verification and PIN reset.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  target      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'phone' CHECK (target_type IN ('phone','email')),
  code        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'verify' CHECK (purpose IN ('verify','reset_pin','login','transfer_confirm')),
  used        BOOLEAN NOT NULL DEFAULT false,
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts <= 5),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_target    ON otp_codes(target, purpose) WHERE NOT used;
CREATE INDEX IF NOT EXISTS idx_otp_codes_user      ON otp_codes(user_id) WHERE NOT used;
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires   ON otp_codes(expires_at);
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "otp_codes: service only" ON otp_codes FOR ALL USING (true) WITH CHECK (true);

-- ── User Devices ──────────────────────────────────────────────────────────────
-- Trusted device registry for step-up auth and anomaly detection.
CREATE TABLE IF NOT EXISTS user_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  device_id      TEXT NOT NULL,
  device_name    TEXT,
  platform       TEXT CHECK (platform IN ('ios','android','web','desktop')),
  fingerprint    TEXT,
  push_token     TEXT,
  trusted        BOOLEAN NOT NULL DEFAULT false,
  trust_expires_at TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  last_ip        TEXT,
  last_location  JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user     ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_device   ON user_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_trusted  ON user_devices(user_id, trusted) WHERE trusted = true;
DROP TRIGGER IF EXISTS trg_user_devices_updated ON user_devices;
CREATE TRIGGER trg_user_devices_updated BEFORE UPDATE ON user_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_devices: service only" ON user_devices FOR ALL USING (true) WITH CHECK (true);

-- ── Product Access ────────────────────────────────────────────────────────────
-- Entitlement table: which users have access to which RALD products.
CREATE TABLE IF NOT EXISTS product_access (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  product     TEXT NOT NULL CHECK (product IN ('loop','messenger','payrald','elimu','alia','rald_pro','rald_business')),
  tier        TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','starter','growth','enterprise')),
  granted_by  TEXT NOT NULL DEFAULT 'signup',
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, product)
);
CREATE INDEX IF NOT EXISTS idx_product_access_user    ON product_access(user_id);
CREATE INDEX IF NOT EXISTS idx_product_access_product ON product_access(product, is_active);
DROP TRIGGER IF EXISTS trg_product_access_updated ON product_access;
CREATE TRIGGER trg_product_access_updated BEFORE UPDATE ON product_access
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE product_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_access: service only" ON product_access FOR ALL USING (true) WITH CHECK (true);

-- ── PayRald Voucher Products ───────────────────────────────────────────────────
-- Voucher catalog: what can be purchased via the voucher system.
CREATE TABLE IF NOT EXISTS payrald_voucher_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  category      TEXT NOT NULL CHECK (category IN ('airtime','data','electricity','tv','betting','education','other')),
  provider      TEXT NOT NULL,
  provider_code TEXT,
  denominations JSONB NOT NULL DEFAULT '[]',
  min_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  max_amount    NUMERIC(15,2) NOT NULL DEFAULT 999999,
  fee_flat      NUMERIC(10,2) NOT NULL DEFAULT 0,
  fee_percent   NUMERIC(5,4) NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_variable   BOOLEAN NOT NULL DEFAULT false,
  country_code  TEXT NOT NULL DEFAULT 'NG',
  icon_url      TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voucher_products_category ON payrald_voucher_products(category, is_active);
CREATE INDEX IF NOT EXISTS idx_voucher_products_provider ON payrald_voucher_products(provider);
CREATE INDEX IF NOT EXISTS idx_voucher_products_country  ON payrald_voucher_products(country_code, is_active);
DROP TRIGGER IF EXISTS trg_voucher_products_updated ON payrald_voucher_products;
CREATE TRIGGER trg_voucher_products_updated BEFORE UPDATE ON payrald_voucher_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE payrald_voucher_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voucher_products: service only" ON payrald_voucher_products FOR ALL USING (true) WITH CHECK (true);

-- ── Voucher Seed Data ──────────────────────────────────────────────────────────
INSERT INTO payrald_voucher_products (name, slug, category, provider, provider_code, denominations, min_amount, max_amount, fee_flat, is_variable, is_active) VALUES
  ('MTN Airtime',    'mtn-airtime',    'airtime',     'MTN',     'MTN',     '[50,100,200,500,1000,2000,5000]',  50,    5000, 0, false, true),
  ('Airtel Airtime', 'airtel-airtime', 'airtime',     'Airtel',  'AIRTEL',  '[50,100,200,500,1000,2000]',       50,    2000, 0, false, true),
  ('Glo Airtime',    'glo-airtime',    'airtime',     'Glo',     'GLO',     '[50,100,200,500,1000,2000]',       50,    2000, 0, false, true),
  ('9mobile Airtime','9mobile-airtime','airtime',     '9mobile', '9MOBILE', '[50,100,200,500,1000]',            50,    1000, 0, false, true),
  ('MTN Data',       'mtn-data',       'data',        'MTN',     'MTN_DATA','[100,200,500,1000,2000,5000]',     100,   5000, 0, false, true),
  ('DSTV Compact',   'dstv-compact',   'tv',          'DSTV',    'DSTV',    '[10750]',                          10750, 10750,0, false, true),
  ('IKEDC Token',    'ikedc-token',    'electricity', 'IKEDC',   'IKEDC',   '[]',                               1000, 50000,50, true, true)
ON CONFLICT (slug) DO NOTHING;
