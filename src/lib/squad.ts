// RALD PayRald Core — Squad Co client (Cloudflare Worker compatible)
// Uses Web Crypto for webhook verification — NO Node.js crypto imports.
// LILCKY STUDIO LIMITED

export class SquadError extends Error {
  constructor(message: string, public readonly status: number, public readonly raw: unknown) {
    super(message);
    this.name = "SquadError";
  }
}

export interface SquadBindings {
  SQUADCO_SECRET_KEYS: string;
  SQUADCO_PUBLIC_KEY:  string;
  SQUAD_ENV?:          string;
}

async function squadReq<T>(
  key: string, base: string, method: string, path: string, body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { status?: number; success?: boolean; message?: string; data?: T };
  if (!res.ok || data.success === false) {
    throw new SquadError(data.message ?? `Squad API error ${res.status}`, res.status, data);
  }
  return (data.data ?? data) as T;
}

export function squadClient(env: SquadBindings) {
  const key  = env.SQUADCO_SECRET_KEYS;
  const base = env.SQUAD_ENV === "production" ? "https://api.squadco.com" : "https://api-d.squadco.com";

  return {
    async initiateTransfer(p: {
      accountNumber: string; accountName: string; bankCode: string;
      amountNgn: number; remark: string; transactionRef: string;
    }) {
      return squadReq<{ transaction_reference: string; amount: number; status: string }>(
        key, base, "POST", "/payout/initiate", {
          remark: p.remark, bank_code: p.bankCode, account_number: p.accountNumber,
          account_name: p.accountName, amount: Math.round(p.amountNgn * 100),
          currency_id: "NGN", transaction_ref: p.transactionRef,
        }
      );
    },

    async verifyAccountName(p: { accountNumber: string; bankCode: string }) {
      return squadReq<{ account_name: string; account_number: string; bank_code: string }>(
        key, base, "POST", "/payout/account/lookup",
        { bank_code: p.bankCode, account_number: p.accountNumber }
      );
    },

    async createVirtualAccount(p: {
      firstName: string; lastName: string; email: string; phone: string;
      bvn?: string; customerIdentifier: string;
    }) {
      return squadReq<{
        virtual_account_number: string; bank_code: string; bank_name: string;
        customer_identifier: string; beneficiary_account: string;
      }>(key, base, "POST", "/virtual-account", {
        first_name: p.firstName, last_name: p.lastName,
        mobile_num: p.phone.replace(/\D/g, ""), email: p.email,
        bvn: p.bvn ?? "", beneficiary_account: env.SQUADCO_PUBLIC_KEY,
        customer_identifier: p.customerIdentifier,
      });
    },

    async verifyTransaction(ref: string) {
      return squadReq<{ transaction_reference: string; amount: number; status: string }>(
        key, base, "GET", `/transaction/verify/${ref}`
      );
    },

    async getBalance() {
      return squadReq<{ balance: number; currency: string }>(key, base, "GET", "/merchant/balance");
    },

    async verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
      try {
        const cryptoKey = await crypto.subtle.importKey(
          "raw", new TextEncoder().encode(key),
          { name: "HMAC", hash: "SHA-512" }, false, ["verify"]
        );
        const sigBytes = new Uint8Array(signature.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, new TextEncoder().encode(rawBody));
      } catch { return false; }
    },
  };
}
