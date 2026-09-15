/** Filter last activity by a calendar day in the viewer's local timezone. */
export function conversationListQuery(date: string, offset: number): string {
  const query = new URLSearchParams({ limit: "25", offset: String(offset) });
  if (date) {
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    query.set("from", from.toISOString());
    query.set("to", to.toISOString());
  }
  return query.toString();
}
