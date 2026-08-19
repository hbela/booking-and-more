---
slug: two-editors-one-diary
title: Two editors, one diary
excerpt: How to stop a receptionist and a doctor from silently deleting each other's work — the bug, the two-step fix, the race the first fix didn't close, and the checklist to steal.
---

_A worked example from a multi-tenant booking SaaS built on Fastify, Prisma and PostgreSQL 18._

---

## The shape of the problem

We had just shipped diary delegation. An owner can hand a provider's diary — their availability,
their bookings, or both — to a member of staff. A receptionist holds several diaries; a doctor and
their assistant now both edit the same week.

Somebody asked the obvious question of the finished feature: _how do we manage conflict between a
provider and her assistant?_

The honest answer took an audit to produce, and one row of it was a defect:

| conflict                                   | what protected us                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both act on the same **booking**           | A state machine where terminal is terminal, an exclusion constraint that decides who got the slot, and an `Idempotency-Key` on every retryable write. Refused cleanly. |
| an availability edit **strands a booking** | A 409 listing the appointments, re-sent with an acknowledgement. Already handled.                                                                                      |
| both edit the **same week**                | **Nothing at all.**                                                                                                                                                    |
| they simply disagree                       | Not a software question.                                                                                                                                               |

The third row is the one worth writing about, because the reason it was empty is a reason that
recurs everywhere.

### Why the existing protections didn't reach it

Bookings were safe because a booking is a _row with identity_ that moves through _states_. Every
concurrency tool we owned was built for that shape.

A schedule is not that shape. `PUT /v1/providers/:id/working-hours` takes **the whole week** and
replaces it — delete-then-insert inside a transaction. The rows carry no identity anybody refers to,
so there was no version column, no `If-Match`, no `updatedAt` check. Nothing.

The failure mode:

1. The provider opens her week.
2. The assistant adds Friday afternoon and saves.
3. The provider saves her form, built from the read she took before step 2.
4. Friday afternoon disappears. **No error. No trace either of them will ever see.**

The bug predated delegation. What delegation changed was its _probability_. Before, it took two
owners editing one diary, which is rare. An assistant is a second editor **by design**, so the
expected configuration became the one that triggers it.

> **The general lesson.** A whole-set `PUT` is a lost-update bug with a delay fuse. It is invisible
> while exactly one person edits, and it fires the day you add the second. If you are about to
> introduce a second editor to anything, that is the moment to go looking — not after the first
> support ticket, because there will not be one. Nobody reports a Friday afternoon that quietly
> stopped existing.

---

## Step 1: visibility first, because it's nearly free

Before writing any concurrency control, we shipped the cheap half: `GET …/working-hours` gained a
`lastChange` field, and the editor renders _"Last changed by Réka, 10 minutes ago."_

It prevents nothing. We kept it after building the real fix anyway, because the two answer different
questions. A version check refuses a **collision**. This line answers _"has anything moved since I
last looked"_ on a screen nobody is mid-save on — which is most screens, most of the time.

Four decisions inside it are worth copying:

**Use the audit log as the source, not a column.** We already write an audit row on every save. A
whole-week replace would reset any `updatedBy` column we put on the table — _including on rows the
save did not change_ — and a second source of one fact is a second thing to keep true. Consequence:
**no migration**.

```ts
// Served by @@index([entityType, entityId]).
const entry = await this.prisma.auditLog.findFirst({
  where: {
    tenantId: args.tenantId,
    entityType: "Provider",
    entityId: args.providerId,
    action: "availability.working_hours_changed",
  },
  orderBy: { createdAt: "desc" },
  select: { actorId: true, createdAt: true },
});
```

**Put it on the existing `GET`, not on an endpoint of its own.** It describes exactly the set being
returned. Two requests could disagree — a week from one moment attributed to a save from another.

**Accept that it is eventually consistent.** `request.audit()` is fire-and-forget on purpose: an
audit failure must never fail a schedule save. So the line can lag by a moment. That only ever
affects attributing _your own_ save immediately after making it — the one case where the reader
already knows the answer. The integration test asserts through the API with `vi.waitFor` rather than
reaching into the table, so it proves the model the screen actually sees.

**Don't put a foreign key on `actorId`.** The name is a second lookup, and a miss renders as a time
with no name rather than a missing line. An audit trail that cascades away when an account is
deleted is not an audit trail.

---

## Step 2: the version check — a content fingerprint

The real fix. `GET` returns a `fingerprint`; the `PUT` requires it back as `expectedFingerprint`; a
mismatch is `SCHEDULE_MODIFIED` (409) carrying the current fingerprint and `lastChange`. Still no
migration.

Five decisions, each of which was either the second thing we tried or the thing that made the first
one wrong.

### 2.1 Hash the content, not the identity

The obvious fingerprint is the row ids. Every save mints new ones — the replace is
delete-then-insert — so it changes reliably. We rejected it.

Two saves producing an **identical week** would then conflict. Refusing somebody because a colleague
saved the very hours they are looking at is a dialog about nothing. Hashing the fields also survives
a partial-update writer that doesn't exist yet: if somebody later adds a route that flips `active` on
one row, an id-based hash would not notice, and this one does.

```ts
export function fingerprintWorkingHours(rows: FingerprintableWorkingHours[]): string {
  const lines = rows
    .map((row) =>
      [
        row.weekday,
        row.startTime,
        row.endTime,
        row.locationId ?? "",
        row.validFrom === null ? "" : row.validFrom.toISOString().slice(0, 10),
        row.validUntil === null ? "" : row.validUntil.toISOString().slice(0, 10),
        row.active ? "1" : "0",
      ].join("|"),
    )
    .sort();

  // The empty week hashes to a constant, which is correct: "this diary has no
  // hours" is one state, and every fresh provider is legitimately in it.
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}
```

Three details in twenty lines:

- **`.sort()` on the serialised tuples, not trust in the query order.** The repository orders by
  `(weekday, startTime)`, which is _not a total order_ — two periods can share both and differ by
  location. Without the sort, one week could fingerprint two ways and refuse a caller who did nothing
  wrong.
- **A separator inside each tuple.** `09:00` + `17:00` and `09:0` + `017:00` must not collide. There
  is a test for exactly that.
- **Truncated to 32 hex characters.** This is a change detector, not a security boundary. Nothing is
  authorised by it, and a caller who forges one can only overwrite a diary they already hold the
  permission to overwrite.

### 2.2 Compare it _inside_ the transaction

Comparing in the service layer, before the repository call, leaves exactly the window the check
exists to close: between "still matches" and `deleteMany`, the other editor commits and is deleted
anyway.

```ts
return this.prisma.$transaction(async (tx) => {
  const current = await tx.workingHours.findMany({ where: { tenantId, providerId } });
  const actual = fingerprintWorkingHours(current);

  if (actual !== expectedFingerprint) {
    // Bare, so the transaction unwinds before anything reads the audit log to
    // find out who. The service turns it into the wire error.
    throw new ScheduleModifiedError(actual);
  }

  await tx.workingHours.deleteMany({ where: { tenantId, providerId } });
  // …createMany…
});
```

Note the error is bare and internal. The _service_ catches it and only then spends a query looking up
who the other editor was:

```ts
catch (cause) {
  if (!(cause instanceof ScheduleModifiedError)) throw cause;

  // Only now, once we know there is a conflict to report: looking them up on
  // the happy path would put an audit query on every save to answer a question
  // nobody asked.
  const lastChange = await this.repository.findLastWorkingHoursChange({ tenantId, providerId });
  throw new ConflictError(ErrorCodes.SCHEDULE_MODIFIED, "…", { /* currentFingerprint, lastChange */ });
}
```

---

## Step 3: the race the version check didn't close

This is the part most write-ups leave out, so here it is in full.

The first version of `replaceWorkingHours` took **no row lock**, and the comment explaining why was
confident:

> The read is `SELECT … FOR UPDATE`-free on purpose: Postgres' default READ COMMITTED lets two
> transactions both pass the check and serialise their deletes, so in principle one could still be
> lost. It cannot happen here because both would have had to read the _same_ fingerprint, meaning
> both bodies were built from the same week — so the loser overwrites with a body that saw everything
> the winner saw.

A code review pulled that apart, and it was right to. **Two bodies built from the same base are not
the same body.**

1. Alice and Bob both read fingerprint `F0`.
2. Alice adds a Monday period. Bob changes Tuesday.
3. Both transactions read `F0` before either commits, so **both pass the check**.
4. Depending on statement timing, the later delete erases the first replacement — or the two
   replacement sets combine. Neither result preserves whole-set semantics.

"Both saw the same starting week" says nothing about whether their _edits_ were the same. The
argument confused the read with the write.

### The fix: lock a stable row

```ts
return this.prisma.$transaction(async (tx) => {
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM providers
    WHERE id = ${providerId} AND tenant_id = ${tenantId}
    FOR UPDATE
  `);

  const current = await tx.workingHours.findMany({ where: { tenantId, providerId } });
  // …fingerprint check, delete, insert…
});
```

**Why the provider row and not the working-hours rows.** Locking the schedule rows is not sufficient,
for two reasons that both come from the whole-set shape: an empty week has _no row to lock_, and
delete-then-insert changes the rows' identities anyway. The provider row is the stable target — it
exists before the first schedule does and survives every replacement of it.

Once the lock is held, competing saves queue. The second transaction then reads the _first one's
replacement_ and fails its fingerprint check, instead of silently overwriting it. The fingerprint
stays the user-facing conflict detector; **the database lock is the serialization mechanism.** That
division is the point.

**Test it with a real race, not a sequence.** A test that saves, then saves again with a stale token,
proves the comparison works. It does not prove the transaction is safe. This one does:

```ts
it("serializes two simultaneous saves made from the same version", async () => {
  const shared = await fingerprintOf(site);

  const save = (weekday: number) => app.inject({/* …expectedFingerprint: shared… */});

  const responses = await Promise.all([save(1), save(2)]);

  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  // …and the week that survives contains exactly one of the two bodies, whole.
});
```

The final assertion matters as much as the status codes: exactly one succeeds, and the week is _one_
of the two bodies rather than a merge of both.

---

## Step 4: two API-contract details that are easy to get wrong

### Make the field required — but refuse it in the handler, not in the schema

`expectedFingerprint` is declared **optional in Zod** and required by a helper called after the
permission check. That looks like sloppiness. It isn't.

Fastify validates the body **before** the `preHandler` chain. So a genuinely required field answers a
caller _who has no permission on this diary_ with a 422 about a missing field, instead of a 403. You
leak the shape of an endpoint to someone who may not use it, and you send them looking for a field
when the real problem is access.

```ts
export function requireScheduleFingerprint(value: string | undefined): string {
  const fingerprint = value?.trim() ?? "";

  if (fingerprint.length === 0) {
    throw new AppError(
      ErrorCodes.SCHEDULE_FINGERPRINT_REQUIRED,
      "This request must carry `expectedFingerprint` from a current read of this provider's working hours.",
      { statusCode: 400 },
    );
  }

  return fingerprint;
}
```

There is a test pinning that ordering, because it is exactly the kind of thing a later refactor
"tidies up". It gets its own error code, too: _"you did not read before writing"_ is a different fix
from _"your body is malformed"_.

And it is never optional "for now". A concurrency field that is optional is absent exactly when it
matters, because nobody adds one until after the save that ate somebody's afternoon.

### Never merge two 409s that mean opposite things

This one route now returns two different conflicts:

| code                          | means                                          | what the client does                    |
| ----------------------------- | ---------------------------------------------- | --------------------------------------- |
| `SCHEDULE_CONFLICTS_BOOKINGS` | "your change costs these appointments"         | re-send **the same body**, acknowledged |
| `SCHEDULE_MODIFIED`           | "you are about to undo work you have not seen" | **never** re-send as-is; reload first   |

Same status, opposite handling. Merging them — or letting a client branch on `409` alone — turns a
data-loss guard into a confirm button. Give them separate codes and keep the reader-side parsers
separate too. Ours returns `undefined` for _"not this error"_ and `null` for _"this error, but the
audit trail hasn't caught up and there's nobody to name"_ — so a lagging trail still stops the save
rather than falling through to the generic handler.

---

## Step 5: the client-side trap

The version you send must be the version the body was built from. That sounds tautological until your
data-fetching library helps.

```tsx
// The version of the week this form was seeded from.
//
// Held in state and set in the *same* effect as `week`, never read from
// `stored.data` at submit time: a background refetch updates the query data one
// render before the effect re-seeds the form, and reading it there would send
// the new fingerprint with the old body — which is precisely the stale
// whole-set write this exists to refuse.
const [fingerprint, setFingerprint] = useState<string | null>(null);

useEffect(() => {
  if (!stored.data) return;
  // Both, together, from one read.
  setWeek(seedWorkingWeek(stored.data.items));
  setFingerprint(stored.data.fingerprint);
}, [stored.data]);
```

Read `stored.data.fingerprint` at submit time and you build the perfect stale write: TanStack Query
refetches in the background, the query cache holds the _new_ fingerprint, your form still holds the
_old_ week, and you have just told the server that your stale body is current. The check passes and
the data is lost — by the mechanism installed to prevent it.

**Rule: the version token and the data it describes are one value. Seed them together, hold them
together, send them together.**

The refusal itself renders as a callout naming the other editor with a Reload button — and the copy
says _before_ the press that reloading replaces what is on screen. The save was refused, so nothing
is lost yet; the reload is the destructive step, and it should say so.

---

## What we deliberately did not fix

Being explicit about the edges is part of the write-up:

- **Three other whole-set `PUT`s still have no version check** — provider services, provider
  locations, service translations. They are one-owner-at-a-time in practice. The fingerprint is small
  enough to lift when that stops being true, and it is deliberately _named for its table_ rather than
  generalised on speculation.
- **Availability exceptions have no version check either.** They are per-row create/update/delete
  rather than a whole-set replace, so a concurrent edit cannot clobber a set.
- **There is no audit-viewing UI.** The `lastChange` line is now the only audit data any user of the
  product can see. _"Who changed my Friday, and to what?"_ still requires database access. Named as a
  gap rather than solved, because a general audit screen is its own piece of work.
- **"They simply disagree"** is still not a software problem. Staffing is the owner's decision; a
  provider who wants a different assistant asks the owner. Worth writing down, because otherwise
  somebody reports it as a bug.

---

## The checklist

For the next time you add a second editor to anything:

1. **Inventory the conflicts before designing.** Write the table. Some rows are already handled by
   machinery you built for a different reason; at least one will be empty.
2. **Find every whole-set `PUT`.** Each is a silent lost update waiting for a second editor.
3. **Ship visibility first.** _"Last changed by X, N minutes ago"_ is often a day's work, needs no
   migration if you already audit, and it is still worth having after the real fix.
4. **Version by content, not by identity or by `updatedAt`.** Identical states must compare equal, or
   you will refuse people over nothing.
5. **Compare inside the write transaction.** Anywhere else and you have merely narrowed the window.
6. **Take a lock on a stable row.** The check alone is not enough under READ COMMITTED. Fingerprint =
   the message to the human; lock = the guarantee.
7. **Test with `Promise.all`, not with a sequence.** And assert the surviving state is _one_ body,
   not a merge.
8. **Watch the validation/authorization ordering.** A required field enforced too early answers the
   wrong question first.
9. **Give the refusal its own error code**, distinct from any other conflict on the same route, and
   distinct from "your body is wrong".
10. **On the client, seed the version and the data in the same effect.** A background refetch is all
    it takes to invert your protection.

The through-line: **the fingerprint is a message to a human, and the lock is the guarantee.** Confuse
the two and you end up with a very well-explained lost update.
