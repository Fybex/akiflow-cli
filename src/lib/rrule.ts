/** Helpers for working with Akiflow recurrence values (iCal RRULE strings). */

/** Normalize a user-supplied recurrence into a canonical 'RRULE:...' line, or null if invalid. */
export function normalizeRrule(input: string): string | null {
  const upper = input.trim().toUpperCase();
  if (!upper) return null;
  if (upper.startsWith("RRULE:")) return upper.includes("FREQ=") ? upper : null;
  if (upper.startsWith("FREQ=")) return `RRULE:${upper}`;
  return null;
}

/** Extract the RRULE line from a recurrence value (string or array of iCal lines). */
export function extractRrule(
  recurrence: string | string[] | null | undefined
): string | null {
  if (!recurrence) return null;
  const lines = Array.isArray(recurrence) ? recurrence : [recurrence];
  return lines.find((l) => l.toUpperCase().startsWith("RRULE:")) ?? null;
}

/** Return an RRULE with its UNTIL clause set to the given iCal UTC stamp (replacing any existing UNTIL). */
export function rruleWithUntil(rrule: string, untilStamp: string): string {
  const stripped = rrule.replace(/;?UNTIL=[^;]*/i, "");
  return `${stripped};UNTIL=${untilStamp}`;
}

/** iCal UTC stamp (YYYYMMDDT235959Z) for the day BEFORE the given YYYY-MM-DD date. */
export function icalUntilDayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}T235959Z`;
}
