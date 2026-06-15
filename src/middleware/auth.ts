// RALD PayRald Core — Auth middleware
// LILCKY STUDIO LIMITED

import type { MiddlewareHandler } from "hono";
import { verifyJwt, bearerToken, type JwtPayload } from "../lib/auth";
import type { Bindings, Variables } from "../index";

export function authRequired(): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization: Bearer <token> required", code: "MISSING_TOKEN" }, 401);
    const user = await verifyJwt(token, c.env.RALD_JWT_SECRET);
    if (!user) return c.json({ error: "Invalid or expired token", code: "INVALID_TOKEN" }, 401);
    c.set("user",   user);
    c.set("rawJwt", token);
    await next();
  };
}

export function internalOnly(): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const secret  = c.req.header("X-Internal-Secret");
    const service = c.req.header("X-Source-Service");
    if (secret && secret === c.env.MACHINE_IDENTITY_SECRET) { await next(); return; }
    // Also accept a valid RALD JWT with machine role
    const token = bearerToken(c.req.header("Authorization"));
    if (token) {
      const payload = await verifyJwt(token, c.env.RALD_JWT_SECRET).catch(() => null);
      if (payload && (payload as unknown as { role: string }).role === "machine") { await next(); return; }
    }
    return c.json({ error: "Internal access only", code: "FORBIDDEN" }, 403);
  };
}
