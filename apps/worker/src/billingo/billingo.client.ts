export interface BillingoAddress {
  country_code: string;
  post_code: string;
  city: string;
  address: string;
}

export interface BillingoPartnerInput {
  name: string;
  address: BillingoAddress;
  emails: string[];
  taxcode?: string;
  tax_type: "FOREIGN" | "HAS_TAX_NUMBER" | "NO_TAX_NUMBER";
}

export interface BillingoPartner extends BillingoPartnerInput {
  id: number;
}

export interface BillingoDocument {
  id: number;
  invoice_number: string;
  gross_total: number;
  currency: string;
}

export interface BillingoDocumentInput {
  vendor_id: string;
  partner_id: number;
  block_id: number;
  bank_account_id: number;
  type: "invoice";
  fulfillment_date: string;
  due_date: string;
  payment_method: "bankcard";
  language: "hu" | "en";
  currency: "HUF";
  electronic: true;
  paid: true;
  items: Array<{
    name: string;
    unit_price: number;
    unit_price_type: "gross";
    quantity: 1;
    unit: string;
    vat: "AAM";
  }>;
  comment: string;
}

interface BillingoPage<T> {
  data: T[];
}

export class BillingoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BillingoApiError";
  }
}

export interface BillingoClient {
  listBankAccounts: () => Promise<Array<{ id: number; name?: string }>>;
  listDocumentBlocks: () => Promise<Array<{ id: number; name?: string }>>;
  findPartners: (query: string) => Promise<BillingoPartner[]>;
  createPartner: (input: BillingoPartnerInput) => Promise<BillingoPartner>;
  updatePartner: (id: number, input: BillingoPartnerInput) => Promise<BillingoPartner>;
  getDocumentByVendorId: (vendorId: string) => Promise<BillingoDocument | null>;
  createDocument: (input: BillingoDocumentInput) => Promise<BillingoDocument>;
}

export interface BillingoClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createBillingoClient(options: BillingoClientOptions): BillingoClient {
  const request = createRequest(options);

  return {
    listBankAccounts: async () =>
      (await request<BillingoPage<{ id: number; name?: string }>>("/bank-accounts?per_page=100"))
        .data,
    listDocumentBlocks: async () =>
      (await request<BillingoPage<{ id: number; name?: string }>>("/document-blocks?per_page=100"))
        .data,
    findPartners: async (query) =>
      (
        await request<BillingoPage<BillingoPartner>>(
          `/partners?per_page=100&query=${encodeURIComponent(query)}`,
        )
      ).data,
    createPartner: (input) =>
      request<BillingoPartner>("/partners", { method: "POST", body: JSON.stringify(input) }),
    updatePartner: (id, input) =>
      request<BillingoPartner>(`/partners/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    getDocumentByVendorId: async (vendorId) => {
      try {
        return await request<BillingoDocument>(`/documents/vendor/${encodeURIComponent(vendorId)}`);
      } catch (error) {
        if (error instanceof BillingoApiError && error.status === 404) return null;
        throw error;
      }
    },
    createDocument: (input) =>
      request<BillingoDocument>("/documents", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
}

function createRequest(options: BillingoClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async function billingoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": options.apiKey,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      const retryAfter = response.headers.get("retry-after");
      const suffix = body === "" ? "" : `: ${body.slice(0, 1_000)}`;

      throw new BillingoApiError(
        `Billingo API ${response.status}${suffix}`,
        response.status,
        retryAfter === null ? undefined : Number.parseInt(retryAfter, 10),
      );
    }

    return (await response.json()) as T;
  };
}
