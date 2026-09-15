import { wallClockToEpochMs } from "@bam/availability-engine";

/** A Monday 7–13 calendar days ahead, inside the default booking horizon. */
export function futureMonday(now = new Date()): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 7 + ((8 - date.getUTCDay()) % 7));
  return date.toISOString().slice(0, 10);
}

/** Express fixtures as the provider's local hour, including winter time. */
export function budapestHour(date: string, hour: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  return new Date(
    wallClockToEpochMs(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour,
        minute: 0,
      },
      "Europe/Budapest",
    ),
  ).toISOString();
}
