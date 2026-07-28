/**
 * Drop keys whose value is `undefined`, keeping explicit `null`s.
 *
 * The distinction is the whole point of PATCH: an absent key means "leave this
 * alone", an explicit `null` means "clear it". Under
 * `exactOptionalPropertyTypes` a present-but-undefined key is also not the same
 * as an omitted one to Prisma, which would happily write `undefined` over a
 * value it should not have touched.
 */
export function definedOnly<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
