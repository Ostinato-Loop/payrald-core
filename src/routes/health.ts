// RALD PayRald Core — Health routes
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get("/health", (c) => c.json({
  status: "ok", service: "payrald-core", version: "1.0.0",
  environment: c.env.ENVIRONMENT ?? "production",
  features: ["transfers", "withdrawals", "squad-webhooks", "alia-resolution"],
  timestamp: new Date().toISOString(),
}));

export default app;
