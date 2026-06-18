# WIZMAC — payrald-core
> PayRald Core — Payment Engine
> Last updated: 2026-06-17 — LILCKY STUDIO LIMITED

---

## 1. Product Overview
**payrald-core** is the central payment engine of the RALD ecosystem. It handles wallet management, transfers (P2P), withdrawals (Squad Co), vouchers, settlements, and merchant payouts. All monetary operations flow through this service.

| Field | Value |
|-------|-------|
| Live URL | `https://core.pay.rald.cloud` |
| Repo | `Ostinato-Loop/payrald-core` |
| Stack | Cloudflare Worker (Hono) |
| Database | Supabase `onxdcikfttdmnhofsuwo.supabase.co` |
| Payment Provider | Squad Co (Nigeria) |
| Version | 1.1.0 |

---

## 2. Architecture
| Layer | Stack | Deployment |
|-------|-------|------------|
| API Worker | Cloudflare Worker (Hono) | `core.pay.rald.cloud` |
| Database | Supabase PostgreSQL | `onxdcikfttdmnhofsuwo.supabase.co` |
| Payments | Squad Co API | `sandbox-api.squadco.com` → `api.squadco.com` |
| Rate Limiting | Cloudflare KV | `RATE_LIMIT_KV` binding ⚠️ needs provisioning |
| Currency | NGN (Naira) only | Kobo precision (×100) |

---

## 3. Auth Flow
```
1. All requests require: Authorization: Bearer <RALD_JWT>
2. Wallet endpoints also accept X-Internal-Secret (for identity chain)
3. POST /internal/wallets/provision: X-Internal-Secret only (no user JWT)
4. Webhook endpoints (/webhooks/squad): Squad signature verification
```

---

## 4. Database Schema
```sql
-- Core tables (from supabase-schema.sql)
payrald_wallets (id, user_id UNIQUE, wallet_type, total_balance, available_balance,
  pending_balance, currency, virtual_account_number, virtual_account_bank,
  virtual_account_ref, squad_virtual_ref, kyc_tier, trust_score, is_frozen,
  freeze_reason, daily_limit, daily_used, daily_reset_at, last_activity_at,
  created_at, updated_at)

payrald_transactions (id, wallet_id, user_id, type, amount, fee, currency,
  direction, status, reference, external_ref, squad_ref, description, metadata,
  created_at, updated_at)

payrald_transfers (id, sender_wallet_id, receiver_wallet_id, sender_id,
  receiver_id, amount, fee, currency, status, reference, alia_alias,
  description, metadata, created_at, updated_at)

payrald_withdrawals (id, wallet_id, user_id, amount, fee, currency,
  bank_code, account_number, account_name, status, reference, squad_ref,
  narration, metadata, created_at, updated_at)

payrald_merchant_profiles (id, user_id, merchant_alias, merchant_type,
  display_name, category, country, trust_score, compliance_status,
  is_active, is_verified, ...)

payrald_routing_profiles (id, entity_type, entity_id, alias_type,
  alias_value, target_wallet_id, verified, ...)

-- Migration 002 tables (PENDING EXECUTION)
otp_codes (id, user_id, identifier, code_hash, purpose, expires_at, used_at,
  attempts, ip, created_at)

user_devices (id, user_id, device_id, device_name, platform, push_token,
  fingerprint, last_seen_at, trusted, revoked, created_at)

product_access (id, user_id, product, plan, granted_by, active, expires_at,
  metadata, created_at, updated_at)

payrald_voucher_products (id, merchant_id, name, description, category,
  price_ngn, original_price, discount_pct, stock_unlimited, stock_count,
  active, valid_days, terms, image_url, metadata, created_at, updated_at)

-- Nigerian banks seed (44 banks seeded in supabase-schema.sql)
payrald_banks (code PK, name, short_name, supported, active)

-- Global merchants seed (10 seeded)
payrald_merchant_profiles (spotify, netflix, openai, canva, adobe, apple,
  google, microsoft, steam, amazon)
```

---

## 5. Key Environment Variables
| Variable | Required | Set In |
|----------|----------|--------|
| `SUPABASE_URL` | ✅ | Cloudflare secret |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ ⚠️ ROTATE | Cloudflare secret |
| `RALD_JWT_SECRET` | ✅ | Cloudflare secret |
| `MACHINE_IDENTITY_SECRET` | ✅ | Cloudflare secret |
| `SQUADCO_SECRET_KEYS` | ✅ | Cloudflare secret |
| `SQUADCO_PUBLIC_KEY` | ✅ | Cloudflare secret |
| `SQUAD_ENV` | ✅ | `sandbox` or `production` |
| `ROUTING_URL` | Optional | `https://routing.rald.cloud` |
| `EVENT_BUS_URL` | Optional | `https://events.rald.cloud` |
| `ENVIRONMENT` | ✅ | `production` |

---

## 6. Live Endpoints
| Method | Path | Auth | Status |
|--------|------|------|--------|
| GET | `/health` | None | ✅ |
| GET | `/healthz` | None | ✅ |
| POST | `/internal/wallets/provision` | `X-Internal-Secret` | ✅ New |
| GET | `/v1/wallet` | JWT | ✅ |
| POST | `/v1/transfers` | JWT | ✅ |
| GET | `/v1/transfers` | JWT | ✅ |
| POST | `/v1/withdrawals` | JWT | ✅ |
| GET | `/v1/withdrawals` | JWT | ✅ |
| POST | `/v1/payments` | JWT | ✅ |
| GET | `/v1/vouchers` | JWT | ✅ |
| POST | `/v1/vouchers/purchase` | JWT | ✅ |
| GET | `/v1/settlements` | Admin JWT | ✅ |
| POST | `/webhooks/squad` | Squad signature | ✅ |

---

## 7. Pending SQL (MUST RUN)
```
File: payrald-core/migrations/002_missing_tables.sql
Creates: otp_codes, user_devices, product_access, payrald_voucher_products
+ auto_provision_wallet trigger on auth_users INSERT
```

---

## 8. CI Pipelines
| Workflow | Trigger | Status |
|----------|---------|--------|
| CI | Push/PR to main | ✅ Green |
| Deploy | Push to main | ✅ Green |

---

## 9. Incidents
| # | Date | Description | Status |
|---|------|-------------|--------|
| P-001 | 2026-06-17 | otp_codes, user_devices, product_access tables missing | ⚠️ Migration 002 ready, pending SQL execution |
| P-002 | 2026-06-17 | RATE_LIMIT_KV binding not provisioned | ⚠️ Manual: wrangler kv namespace create RATE_LIMIT_KV |
| P-003 | 2026-06-17 | /internal/wallets/provision endpoint added for identity chain | ✅ Deployed |
