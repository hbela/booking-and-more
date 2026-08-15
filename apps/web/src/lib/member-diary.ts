import type { Member, Provider } from "./api-client";

/**
 * What the members table's Diary column should say about one membership.
 *
 * ## Why this is a separate, pure module
 *
 * The column has to answer from two sources that disagree about what "absent"
 * means: the membership's own `providerId`, and a list of the tenant's diaries
 * that **is not always loaded**. The providers query is enabled only for a
 * members-manager, so for a `PROVIDER` — who holds `member:read` and not
 * `member:manage` — it never runs.
 *
 * The first version collapsed both into one lookup (`find(…) ?? "(archived
 * diary)"`), which reads correctly for an owner and is a straight falsehood for
 * everybody else: every provider signing in was told their own perfectly
 * healthy diary had been archived. A diary missing *from* a list we hold means
 * archived; not holding the list means nothing at all about that diary.
 *
 * So the list arrives as `Provider[] | null` and the two cases stay apart —
 * expressed in a type rather than remembered, and unit-tested without a DOM,
 * which is where the original would have been caught.
 */
export type DiaryState =
  /** Linked, and we can say to which. */
  | { kind: "named"; displayName: string }
  /** Linked, but we hold no list to name it from. Nothing is wrong. */
  | { kind: "linked" }
  /** Linked, and absent from a list we do hold — archived since linking. */
  | { kind: "archived" }
  /** No diary, and none wanted: an owner or an assistant. */
  | { kind: "none" }
  /** A PROVIDER with no diary: every `:own` permission matches nothing. */
  | { kind: "missing" };

export function resolveDiaryState(args: {
  member: Pick<Member, "role" | "providerId">;
  /** The tenant's diaries, or `null` when they were not fetched. */
  providers: Provider[] | null;
}): DiaryState {
  const { member, providers } = args;

  if (member.providerId !== null) {
    const linked = providers?.find((provider) => provider.id === member.providerId);
    if (linked) return { kind: "named", displayName: linked.displayName };

    return providers === null ? { kind: "linked" } : { kind: "archived" };
  }

  // Only PROVIDER memberships need one. An owner or an assistant with no diary
  // is the normal case and deserves no warning.
  return member.role === "PROVIDER" ? { kind: "missing" } : { kind: "none" };
}
