// RALD PayRald Core — JWT utilities (CF Worker / Web Crypto)
// Mirrors rald-auth-core/src/lib/auth.ts — same algorithm, same key format.
// LILCKY STUDIO LIMITED

export interface JwtPayload {
  id:           string;
  email:        string;
  role:         string;
  username?:    string | null;
  name?:        string | null;
  trust_score?: number;
  trust_level?: string;
  country?:     string | null;
  iat:          number;
  exp:          number;
}

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function enc(s: string): Uint8Array { return new TextEncoder().encode(s); }

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signJwt(
  payload: Record<string, unknown>,
  secret:  string,
  ttl = 86_400
): Promise<string> {
  const header = base64url(enc(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body   = base64url(enc(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttl,
  })));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];
    const key = await hmacKey(secret, ["verify"]);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc(`${header}.${body}`));
    if (!valid) return null;
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as JwtPayload;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

export async function signMachineJwt(secret: string, service = "payrald-core"): Promise<string> {
  const header = base64url(enc(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now    = Math.floor(Date.now() / 1000);
  const body   = base64url(enc(JSON.stringify({
    sub: service, role: "machine", service,
    iss: `${service}.rald.cloud`, iat: now, exp: now + 30,
  })));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

export function bearerToken(h: string | undefined): string | null {
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}
