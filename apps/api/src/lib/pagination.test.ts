import { describe, expect, it } from "vitest";
import { isAppError } from "@bam/contracts";
import { decodeCursor, encodeCursor, pageOf, takeFor } from "./pagination.js";

describe("cursor encoding", () => {
  it("round-trips a sort value and an id", () => {
    const cursor = encodeCursor("Dr. Kovács Anna", "prv_123");
    expect(decodeCursor(cursor)).toEqual({ sortValue: "Dr. Kovács Anna", id: "prv_123" });
  });

  it("round-trips a sort value containing the separator", () => {
    // The separator is a space and names are full of them, so the split has to
    // be on the *first* one. Getting this wrong truncates every multi-word name
    // at its second word.
    const cursor = encodeCursor("Main surgery, second floor", "loc_9");
    expect(decodeCursor(cursor)).toEqual({ sortValue: "Main surgery, second floor", id: "loc_9" });
  });

  it("survives a sort value that is not ASCII", () => {
    const cursor = encodeCursor("Fogkő-eltávolítás", "svc_1");
    expect(decodeCursor(cursor).sortValue).toBe("Fogkő-eltávolítás");
  });

  it("produces something opaque, so clients do not build their own", () => {
    expect(encodeCursor("Alpha", "svc_1")).not.toContain("Alpha");
  });

  it("rejects a cursor it did not issue as a client error, not a server one", () => {
    for (const bad of ["", "not-base64url!!", encodeCursor("", ""), "bm8tc2VwYXJhdG9y"]) {
      let thrown: unknown;
      try {
        decodeCursor(bad);
      } catch (error) {
        thrown = error;
      }

      expect(isAppError(thrown), `"${bad}" should be rejected`).toBe(true);
      // 422, not 500: a bad cursor is a malformed request.
      expect((thrown as { statusCode: number }).statusCode).toBe(422);
    }
  });
});

describe("pageOf", () => {
  const rows = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Bravo" },
    { id: "c", name: "Charlie" },
  ];

  it("asks the database for one row more than the page", () => {
    expect(takeFor(25)).toBe(26);
  });

  it("trims the lookahead row and reports a cursor when there is more", () => {
    const page = pageOf(
      rows,
      2,
      (row) => row.name,
      (row) => row.name,
    );

    expect(page.items).toEqual(["Alpha", "Bravo"]);
    // The cursor points at the last row *returned*, not at the lookahead.
    expect(decodeCursor(page.nextCursor!)).toEqual({ sortValue: "Bravo", id: "b" });
  });

  it("reports no cursor on the last page", () => {
    const page = pageOf(
      rows,
      3,
      (row) => row.name,
      (row) => row.name,
    );

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty result without inventing a cursor", () => {
    const page = pageOf(
      [],
      25,
      () => "",
      (row) => row,
    );

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
