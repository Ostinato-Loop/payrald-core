// RALD PayRald Core — Request logger middleware
// Matches the requestLogger pattern used across the org.
// LILCKY STUDIO LIMITED

import type { MiddlewareHandler } from "hono";

export function requestLogger(service: string): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const { method } = c.req;
    const path = new URL(c.req.url).pathname;
    await next();
    const status    = c.res.status;
    const latency   = Date.now() - start;
    const level     = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    console.log(JSON.stringify({ level, service, method, path, status, latency_ms: latency, ts: new Date().toISOString() }));
  };
}
