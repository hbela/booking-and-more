import { loadEnv } from "@bam/config";
import { createCustomerPii, looksSealed } from "@bam/crypto";
import { normalizeEmail, normalizePhone } from "@bam/booking-engine";
import { createPrismaClient } from "@bam/db";

const args = new Set(process.argv.slice(2));
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const apply = args.has("--apply");
const verify = args.has("--verify");
const finalize = args.has("--finalize");
if (args.has("--dry-run") && (apply || finalize))
  throw new Error("Dry-run cannot be combined with a write mode.");
if ([apply, verify, finalize].filter(Boolean).length > 1) throw new Error("Choose one mode.");
const env = loadEnv();
if (
  (apply || finalize) &&
  (!args.has("--maintenance") ||
    !args.has("--database") ||
    value("--database") !== new URL(env.DATABASE_URL).pathname.slice(1))
) {
  throw new Error(
    "Writes require --maintenance --database <exact database name>, with API and worker stopped.",
  );
}
const pii = createCustomerPii(env.CUSTOMER_PII_ENCRYPTION_KEY, env.CUSTOMER_PII_BLIND_INDEX_KEY);
const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
const open = (value) => (value === null ? null : looksSealed(value) ? pii.open(value) : value);
const sealed = (value) =>
  value === null ? null : looksSealed(value) ? (pii.open(value), value) : pii.seal(value);

async function walk(model, visit) {
  let cursor;
  let count = 0;
  for (;;) {
    const rows = await model.findMany({
      take: 200,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) return count;
    for (const row of rows) {
      await visit(row);
      count++;
    }
    cursor = rows.at(-1).id;
  }
}

function assertSealed(value) {
  if (value !== null) pii.open(value); // Authenticity, not just the envelope prefix.
}

async function validate() {
  const customers = await walk(prisma.customer, async (row) => {
    for (const field of ["fullName", "email", "phone"]) assertSealed(row[field]);
    const email = pii.openNullable(row.email);
    const phone = pii.openNullable(row.phone);
    if (
      row.emailBlindIndex !==
        pii.index(row.tenantId, email === null ? null : normalizeEmail(email)) ||
      row.phoneBlindIndex !== pii.index(row.tenantId, phone === null ? null : normalizePhone(phone))
    )
      throw new Error("Customer index verification failed; no plaintext cleanup performed.");
    if (verify && (row.normalizedEmail !== null || row.normalizedPhone !== null))
      throw new Error("Legacy plaintext lookup values remain; run --finalize in maintenance.");
  });
  const bookings = await walk(prisma.booking, async (row) => {
    for (const field of ["customerNameSnapshot", "customerEmailSnapshot", "customerPhoneSnapshot"])
      assertSealed(row[field]);
  });
  return { customers, bookings };
}

try {
  if (verify || finalize) {
    const counts = await validate();
    if (finalize)
      await prisma.customer.updateMany({ data: { normalizedEmail: null, normalizedPhone: null } });
    console.log(JSON.stringify({ mode: finalize ? "finalize" : "verify", ...counts }));
  } else {
    const before = {
      customers: await prisma.customer.count(),
      bookings: await prisma.booking.count(),
    };
    await walk(prisma.customer, async (row) => {
      const email = open(row.email),
        phone = open(row.phone);
      const data = {
        fullName: sealed(row.fullName),
        email: sealed(row.email),
        phone: sealed(row.phone),
        emailBlindIndex: pii.index(row.tenantId, email === null ? null : normalizeEmail(email)),
        phoneBlindIndex: pii.index(row.tenantId, phone === null ? null : normalizePhone(phone)),
      };
      if (apply)
        await prisma.$transaction(async (tx) => {
          const result = await tx.customer.updateMany({
            where: { id: row.id, updatedAt: row.updatedAt },
            data,
          });
          if (result.count !== 1)
            throw new Error("Concurrent customer write detected; keep maintenance enabled.");
        });
    });
    await walk(prisma.booking, async (row) => {
      const data = Object.fromEntries(
        ["customerNameSnapshot", "customerEmailSnapshot", "customerPhoneSnapshot"].map((field) => [
          field,
          sealed(row[field]),
        ]),
      );
      if (apply)
        await prisma.$transaction(async (tx) => {
          const result = await tx.booking.updateMany({
            where: { id: row.id, updatedAt: row.updatedAt },
            data,
          });
          if (result.count !== 1)
            throw new Error("Concurrent booking write detected; keep maintenance enabled.");
        });
    });
    if (
      before.customers !== (await prisma.customer.count()) ||
      before.bookings !== (await prisma.booking.count())
    )
      throw new Error("Row counts changed during maintenance.");
    if (apply) await validate();
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...before }));
  }
} finally {
  await prisma.$disconnect();
}
