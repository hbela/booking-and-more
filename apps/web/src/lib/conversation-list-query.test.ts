import { describe, expect, it } from "vitest";
import { conversationListQuery } from "./conversation-list-query";

describe("conversation date filter", () => {
  it("leaves the date unrestricted when browsing all dates", () => {
    expect(conversationListQuery("", 25)).toBe("limit=25&offset=25");
  });

  it.each(["2026-09-15", "2026-03-29", "2026-10-25", "2026-12-31"])(
    "uses local midnight through the next calendar day for %s",
    (date) => {
      const query = new URLSearchParams(conversationListQuery(date, 0));
      const from = new Date(query.get("from")!);
      const to = new Date(query.get("to")!);
      expect(from.getHours()).toBe(0);
      expect(to.getHours()).toBe(0);
      expect(from.getDate()).toBe(Number(date.slice(-2)));
      const nextDay = new Date(from);
      nextDay.setDate(nextDay.getDate() + 1);
      expect(to.getTime()).toBe(nextDay.getTime());
      expect(to.getTime()).toBeGreaterThan(from.getTime());
    },
  );
});
