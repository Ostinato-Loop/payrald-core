// RALD PayRald Core — Cloudflare Worker
// Payment engine: ALIA resolution → Squad Co payout → event bus
// Deployed at: core.pay.rald.cloud
// LILCKY STUDIO LIMITED

import { Hono }                      from "hono";
import { cors }                      from "hono/cors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { JwtPayload }           from "./lib/auth";
import { requestLogger }             from "./lib/logger";
import healthRoutes                  from "./routes/health";
import transfersRoutes               from "./routes/transfers";
import withdrawalsRoutes             from "./routes/withdrawals";
import paymentsRoutes                from "./routes/payments";
import vouchersRoutes                from "./routes/vouchers";
import settlementsRoutes             from "./routes/settlements";
import webhooksRoutes                from "./routes/webhooks";

export type Bindings = {
  SUPABASE_URL:              string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RALD_JWT_SECRET:           string;
  MACHINE_IDENTITY_SECRET:   string;
  SQUADCO_SECRET_KEYS:       string;
  SQUADCO_PUBLIC_KEY:        string;
  SQUAD_ENV?:                string;
  ROUTING_URL?:              string;
  EVENT_BUS_URL?:            string;
  PAYRALD_BANK_CODE?:        string;
  ENVIRONMENT?:              string;
};

export type Variables = {
  db:      SupabaseClient;
  user?:   JwtPayload;
  rawJwt?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Health — before all middleware
app.get("/health",  (c) => c.json({ status: "ok", service: "payrald-core", version: "1.0.0", environment: c.env.ENVIRONMENT ?? "production", timestamp: new Date().toISOString() }));
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Security headers
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("X-RALD-Service", "payrald-core");
  c.header("X-RALD-Owner", "LILCKY STUDIO LIMITED");
});

// Logger
app.use("*", requestLogger("payrald-core"));

// CORS
app.use("*", cors({
  origin: (origin) => {
    const allowed = new Set([
      "https://pay.rald.cloud", "https://payrald.rald.cloud",
      "https://api.pay.rald.cloud", "https://routing.rald.cloud",
      "https://auth.rald.cloud", "https://api.rald.cloud",
      "http://localhost:8080", "http://localhost:3000", "http://localhost:5173",
    ]);
    return allowed.has(origin ?? "") ? origin : null;
  },
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Internal-Secret", "X-Source-Service", "X-Transaction-Ref"],
}));

// Boot validation + Supabase per request
app.use("*", async (c, next) => {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RALD_JWT_SECRET", "MACHINE_IDENTITY_SECRET"];
  for (const k of required) {
    if (!c.env[k as keyof Bindings]) return c.json({ error: `Service misconfigured: missing ${k}`, service: "payrald-core" }, 503);
  }
  c.set("db", createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
  await next();
});

app.route("/v1", healthRoutes);
app.route("/",   transfersRoutes);
app.route("/",   withdrawalsRoutes);
app.route("/",   paymentsRoutes);
app.route("/",   vouchersRoutes);
app.route("/",   settlementsRoutes);
app.route("/",   webhooksRoutes);

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[payrald-core]", err.message ?? err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
