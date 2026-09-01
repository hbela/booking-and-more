import { hasBillingo, loadEnvOrExit } from "@bam/config";
import { createBillingoClient, type BillingoPartnerInput } from "./billingo.client.js";

const env = loadEnvOrExit();

if (!hasBillingo(env)) {
  console.error(
    "Billingo is not configured. See .env.example for the required five-variable group.",
  );
  process.exit(1);
}

const client = createBillingoClient({
  apiKey: env.BILLINGO_API_KEY,
  baseUrl: env.BILLINGO_BASE_URL,
});
const bankAccountId = env.BILLINGO_BANK_ACCOUNT_ID;
const documentBlockId = env.BILLINGO_DOCUMENT_BLOCK_ID;
const vatCode = env.BILLINGO_VAT_CODE;
const [bankAccounts, documentBlocks] = await Promise.all([
  client.listBankAccounts(),
  client.listDocumentBlocks(),
]);

const inaccessible = [
  ...(bankAccounts.some((account) => account.id === bankAccountId)
    ? []
    : [`bank account ${String(bankAccountId)}`]),
  ...(documentBlocks.some((block) => block.id === documentBlockId)
    ? []
    : [`document block ${String(documentBlockId)}`]),
];
if (inaccessible.length > 0) {
  console.error(`Billingo configuration is not accessible: ${inaccessible.join(", ")}`);
  process.exit(1);
}

process.stdout.write("Billingo connectivity and configured IDs verified.\n");

if (!process.argv.includes("--apply")) {
  process.stdout.write(
    "Read-only smoke test complete. Pass --apply to create the labeled test invoice.\n",
  );
} else {
  await createTestInvoice();
}

async function createTestInvoice(): Promise<void> {
  const testPartner: BillingoPartnerInput = {
    name: "Booking and More Billingo Smoke Test",
    emails: ["billingo-smoke@example.com"],
    address: {
      country_code: "HU",
      post_code: "1133",
      city: "Budapest",
      address: "Teszt utca 1.",
    },
    tax_type: "NO_TAX_NUMBER",
  };
  const candidates = await client.findPartners(testPartner.emails[0]!);
  const partner =
    candidates.find((candidate) => candidate.emails.includes(testPartner.emails[0]!)) ??
    (await client.createPartner(testPartner));
  const today = new Date().toISOString().slice(0, 10);
  const vendorId = `booking-and-more-smoke-${today}`;
  const existing = await client.getDocumentByVendorId(vendorId);
  const document =
    existing ??
    (await client.createDocument({
      vendor_id: vendorId,
      partner_id: partner.id,
      block_id: documentBlockId,
      bank_account_id: bankAccountId,
      type: "invoice",
      fulfillment_date: today,
      due_date: today,
      payment_method: "bankcard",
      language: "hu",
      currency: "HUF",
      electronic: true,
      paid: true,
      items: [
        {
          name: "Booking and More — Billingo sandbox smoke test",
          unit_price: 24_990,
          unit_price_type: "gross",
          quantity: 1,
          unit: "hó",
          vat: vatCode,
        },
      ],
      comment: "Explicitly created by pnpm billingo:smoke -- --apply",
    }));

  process.stdout.write(
    existing === null
      ? `Created Billingo test invoice ${document.invoice_number}.\n`
      : `Billingo test invoice ${document.invoice_number} already exists; no duplicate created.\n`,
  );
}
