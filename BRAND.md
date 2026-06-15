# PayRald Core

**Service:** `payrald-core`
**Runtime:** Cloudflare Worker
**Framework:** Hono
**Database:** Supabase (shared org instance)
**Deployed at:** `core.pay.rald.cloud`

## Purpose

Authoritative payment engine for the PayRald product.

- Resolves aliases via ALIA (`routing.rald.cloud/resolve`)
- Executes payouts via Squad Co
- Processes Squad webhooks (top-ups, payout confirmations, failures)
- Publishes payment events to `events.rald.cloud`
- Owns `payrald_*` tables in Supabase

## Part of the RALD Ecosystem

Operated by **LILCKY STUDIO LIMITED**
