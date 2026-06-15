// RALD PayRald Core — ALIA Resolution client v1.1.0
// Calls routing.rald.cloud for all alias, merchant, and internal resolution.
// rald-routing handles: trust gate, consent check, machine JWT minting, audit.
// LILCKY STUDIO LIMITED

export interface AliasResolution {
  token:   string;
  routing: {
    destinationBankCode: string;
    destinationBankName: string;
    accountName:         string;
    institutionType:     string;
    isInternal:          boolean;
  };
  resolvedAt:  string;
  latency_ms?: number;
}

export interface MerchantResolution {
  merchantId:      string;
  merchantAlias:   string;
  displayName:     string;
  merchantType:    string;
  settlementType:  "internal" | "bank" | "squad";
  settlementRef?:  string;
  trustScore:      number;
  latency_ms?:     number;
}

export class AliasResolutionError extends Error {
  constructor(
    public readonly alias:      string,
    public readonly code:       string,
    public readonly httpStatus: number
  ) {
    super(`Cannot resolve '${alias}': ${code}`);
    this.name = "AliasResolutionError";
  }
}

type RoutingEnv = { ROUTING_URL?: string };

function routingBase(env: RoutingEnv) {
  return (env.ROUTING_URL ?? "https://routing.rald.cloud").replace(/\/$/, "");
}

/**
 * Resolve a user/email/phone alias → bank routing.
 * rald-routing validates trust_score ≥ 10 and mints the machine JWT.
 */
export async function resolveAliasViaRouting(p: {
  alias:          string;
  userJwt:        string;
  transactionRef: string;
  currency?:      string;
  amount?:        number;
  env:            RoutingEnv;
}): Promise<AliasResolution> {
  const url = routingBase(p.env);
  const res = await fetch(`${url}/resolve`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "Authorization":     `Bearer ${p.userJwt}`,
      "X-Source-Service":  "payrald-core",
      "X-Transaction-Ref": p.transactionRef,
    },
    body: JSON.stringify({
      alias: p.alias, purpose: "payment",
      currency: p.currency ?? "NGN",
      ...(p.amount ? { amount: p.amount } : {}),
    }),
  });

  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new AliasResolutionError(p.alias, (body.code as string) ?? "RESOLUTION_FAILED", res.status);

  const data = body as {
    routing: { token: string; institution_id: string; institution_name: string; institution_type: string; is_internal?: boolean };
    subject: { display_name: string | null };
    alias:   { value: string };
    latency_ms?: number;
  };

  return {
    token: data.routing.token,
    routing: {
      destinationBankCode: data.routing.institution_id,
      destinationBankName: data.routing.institution_name,
      accountName:         data.subject.display_name ?? data.alias.value,
      institutionType:     data.routing.institution_type ?? "commercial_bank",
      isInternal:          data.routing.is_internal === true,
    },
    resolvedAt:  new Date().toISOString(),
    latency_ms:  data.latency_ms,
  };
}

/**
 * Resolve a merchant alias (@spotify, @netflix, @school, etc.).
 * Falls back gracefully if rald-routing merchant endpoint is unavailable.
 */
export async function resolveMerchantViaRouting(p: {
  merchantAlias:  string;
  userJwt:        string;
  transactionRef: string;
  amount?:        number;
  env:            RoutingEnv;
}): Promise<MerchantResolution | null> {
  const url     = routingBase(p.env);
  const alias   = p.merchantAlias.startsWith("@") ? p.merchantAlias : `@${p.merchantAlias}`;
  try {
    const res = await fetch(`${url}/resolve/merchant`, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "Authorization":     `Bearer ${p.userJwt}`,
        "X-Source-Service":  "payrald-core",
        "X-Transaction-Ref": p.transactionRef,
      },
      body: JSON.stringify({ alias, ...(p.amount ? { amount: p.amount } : {}) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      merchant_id:   string;
      alias:         string;
      display_name:  string;
      merchant_type: string;
      settlement:    { type: "internal" | "bank" | "squad"; ref?: string };
      trust_score:   number;
      latency_ms?:   number;
    };
    return {
      merchantId:     data.merchant_id,
      merchantAlias:  data.alias,
      displayName:    data.display_name,
      merchantType:   data.merchant_type,
      settlementType: data.settlement.type,
      settlementRef:  data.settlement.ref,
      trustScore:     data.trust_score,
      latency_ms:     data.latency_ms,
    };
  } catch { return null; }
}

/**
 * Preview alias — public, no auth required.
 */
export async function previewAlias(p: {
  alias: string; env: RoutingEnv;
}): Promise<{ exists: boolean; display_name: string | null; alias_type: string | null; verified: boolean; entity_type: string } | null> {
  const url = routingBase(p.env);
  try {
    const res = await fetch(`${url}/resolve/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: p.alias }),
    });
    if (!res.ok) return null;
    const d = await res.json() as { exists: boolean; display_name?: string | null; alias_type?: string; verified: boolean; entity_type?: string };
    return { exists: d.exists, display_name: d.display_name ?? null, alias_type: d.alias_type ?? null, verified: d.verified, entity_type: d.entity_type ?? "user" };
  } catch { return null; }
}
