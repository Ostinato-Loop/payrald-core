import crypto from "crypto";

const BASE_URL = process.env.SQUAD_ENV === "production"
  ? "https://api.squadco.com"
  : "https://api-d.squadco.com";

const SECRET_KEY = process.env.SQUADCO_SECRET_KEY ?? process.env.SQUADCO_SECRET_KEYS ?? "";
const PUBLIC_KEY = process.env.SQUADCO_PUBLIC_KEY ?? "";

async function squadRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as { status?: number; success?: boolean; message?: string; data?: T };

  if (!res.ok || data.success === false) {
    throw new SquadError(
      data.message ?? `Squad API error ${res.status}`,
      res.status,
      data,
    );
  }

  return (data.data ?? data) as T;
}

export class SquadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "SquadError";
  }
}

export type TransferResult = {
  transaction_reference: string;
  amount: number;
  bank_code: string;
  account_number: string;
  account_name: string;
  status: string;
};

export async function initiateTransfer(params: {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  amountNgn: number;
  remark: string;
  transactionRef: string;
}): Promise<TransferResult> {
  return squadRequest<TransferResult>("POST", "/payout/initiate", {
    remark: params.remark,
    bank_code: params.bankCode,
    account_number: params.accountNumber,
    account_name: params.accountName,
    amount: Math.round(params.amountNgn * 100),
    currency_id: "NGN",
    transaction_ref: params.transactionRef,
  });
}

export type AccountNameResult = {
  account_name: string;
  account_number: string;
  bank_code: string;
};

export async function verifyAccountName(params: {
  accountNumber: string;
  bankCode: string;
}): Promise<AccountNameResult> {
  return squadRequest<AccountNameResult>("POST", "/payout/account/lookup", {
    bank_code: params.bankCode,
    account_number: params.accountNumber,
  });
}

export type VirtualAccountResult = {
  virtual_account_number: string;
  bank_code: string;
  bank_name: string;
  customer_identifier: string;
  beneficiary_account: string;
};

export async function createVirtualAccount(params: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  bvn?: string;
  customerIdentifier: string;
}): Promise<VirtualAccountResult> {
  return squadRequest<VirtualAccountResult>("POST", "/virtual-account", {
    first_name: params.firstName,
    last_name: params.lastName,
    mobile_num: params.phone.replace(/\D/g, ""),
    email: params.email,
    bvn: params.bvn ?? "",
    beneficiary_account: PUBLIC_KEY,
    customer_identifier: params.customerIdentifier,
  });
}

export type TransactionVerifyResult = {
  transaction_reference: string;
  transaction_status: string;
  amount: number;
  currency: string;
};

export async function verifyTransaction(ref: string): Promise<TransactionVerifyResult> {
  return squadRequest<TransactionVerifyResult>("GET", `/transaction/verify/${ref}`);
}

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!SECRET_KEY) return false;
  const computed = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(signature, "hex"),
  );
}
