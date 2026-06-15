// RALD PayRald Core — ALIA Resolution client
// Calls routing.rald.cloud/resolve with the user's RALD JWT.
// rald-routing handles: trust gate, consent check, machine JWT minting, audit.
// LILCKY STUDIO LIMITED

export interface AliasResolution {
  token:   string;
  routing: {
    destinationBankCode: string;
    destinationBankName: string;
    accountName:         string;
    institutionType:     string;
  };
  resolvedAt:  string;
  latency_ms?: number;
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

/**
 * Resolve alias → bank routing via routing.rald.cloud (user-JWT pass-through).
 * rald-routing validates trust_score ≥ 10 and mints the machine JWT for us.
 */
export async function resolveAliasViaRouting(p: {
  alias:           string;
  userJwt:         string;
  transactionRef:  string;
  currency?:       string;
  amount?:         number;
  routingUrl?:     string;
}): Promise<AliasResolution> {
  const url = (p.routingUrl ?? "https://routing.rald.cloud").replace(/\/$/, "");
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

  if (!res.ok) {
    throw new AliasResolutionError(
      p.alias,
      (body.code as string) ?? "RESOLUTION_FAILED",
      res.status
    );
  }

  const data = body as {
    ok:      boolean;
    routing: { token: string; institution_id: string; institution_name: string; institution_type: string };
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
    },
    resolvedAt:  new Date().toISOString(),
    latency_ms:  data.latency_ms,
  };
}

/**
 * Preview alias — public, no auth required.
 * Returns display_name + verified flag without a routing token.
 */
export async function previewAlias(p: {
  alias: string; routingUrl?: string;
}): Promise<{ exists: boolean; display_name: string | null; verified: boolean } | null> {
  const url = (p.routingUrl ?? "https://routing.rald.cloud").replace(/\/$/, "");
  try {
    const res = await fetch(`${url}/resolve/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: p.alias }),
    });
    if (!res.ok) return null;
    const d = await res.json() as { exists: boolean; display_name?: string | null; verified: boolean };
    return { exists: d.exists, display_name: d.display_name ?? null, verified: d.verified };
  } catch { return null; }
}
