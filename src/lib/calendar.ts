import type { AkiflowClient } from "./api/client";
import type { Calendar } from "./api/types";

/**
 * Resolve a writable calendar for creating events.
 * With a name, matches by title (exact, then substring). Without, prefers the
 * Akiflow-primary calendar, then any primary, then the first writable one.
 */
export async function resolveCalendar(
  client: AkiflowClient,
  name?: string
): Promise<Calendar | null> {
  const response = await client.getCalendars();
  const writable = (response.data ?? []).filter(
    (c) => !c.read_only && !c.deleted_at
  );

  if (name) {
    const lower = name.toLowerCase();
    return (
      writable.find((c) => c.title.toLowerCase() === lower) ??
      writable.find((c) => c.title.toLowerCase().includes(lower)) ??
      null
    );
  }

  return (
    writable.find((c) => c.akiflow_primary) ??
    writable.find((c) => c.primary) ??
    writable[0] ??
    null
  );
}

export async function getDefaultCalendarId(client: AkiflowClient): Promise<string | null> {
  try {
    const response = await client.getTimeSlots({ limit: 10 });
    const timeSlots = response.data;

    if (timeSlots.length === 0) {
      return null;
    }

    return timeSlots[0]!.calendar_id;
  } catch {
    return null;
  }
}
