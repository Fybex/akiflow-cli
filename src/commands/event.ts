import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { CreateEventPayload, DeleteEventPayload } from "../lib/api/types";
import {
  getTodayDate,
  getTomorrowDate,
  parseDate,
  parseTime,
  createDateTimeUTC,
  getLocalTimezone,
} from "../lib/date-parser";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { resolveCalendar } from "../lib/calendar";

const DEFAULT_DURATION_SECONDS = 3600;

// Google's legacy color palette (Akiflow stores hex; Google maps to its colorIds).
const COLOR_NAMES: Record<string, string> = {
  lavender: "#a4bdfc",
  sage: "#7ae7bf",
  grape: "#dbadff",
  flamingo: "#ff887c",
  banana: "#fbd75b",
  tangerine: "#ffb878",
  peacock: "#46d6db",
  graphite: "#e1e1e1",
  blueberry: "#5484ed",
  basil: "#51b749",
  tomato: "#dc2127",
};

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Resolve a --color value (palette name or #RRGGBB hex) to a hex string. */
function resolveColor(input: string): string | null {
  const named = COLOR_NAMES[input.toLowerCase()];
  if (named) return named;
  if (HEX_PATTERN.test(input)) return input.toLowerCase();
  return null;
}

function formatLocalTime(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const eventAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Create a real calendar event (synced to Google/Outlook)",
  },
  args: {
    title: {
      type: "positional",
      description: "Event title",
      required: true,
    },
    today: {
      type: "boolean",
      description: "Schedule event for today",
      alias: "t",
    },
    tomorrow: {
      type: "boolean",
      description: "Schedule event for tomorrow",
    },
    date: {
      type: "string",
      description: "Natural language date (e.g., 'next friday', '2026-05-26')",
      alias: "d",
    },
    at: {
      type: "string",
      description: "Start time (e.g., '08:00', '14:30')",
    },
    duration: {
      type: "string",
      description: "Duration (e.g., '30m', '1h', '7h'). Defaults to 1h.",
    },
    calendar: {
      type: "string",
      description: "Calendar name (defaults to your primary writable calendar)",
      alias: "c",
    },
    recurrence: {
      type: "string",
      description: "RRULE string (e.g., 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA')",
    },
    color: {
      type: "string",
      description: "Color: palette name (tangerine, tomato, sage, graphite, ...) or #RRGGBB hex",
    },
    desc: {
      type: "string",
      description: "Event description",
    },
  },
  run: async (context) => {
    const client = createClient();

    const title = context.args.title as string;
    const today = context.args.today as boolean;
    const tomorrow = context.args.tomorrow as boolean;
    const dateInput = context.args.date as string | undefined;
    const timeInput = context.args.at as string | undefined;
    const durationInput = context.args.duration as string | undefined;
    const calendarName = context.args.calendar as string | undefined;
    const recurrenceInput = context.args.recurrence as string | undefined;
    const colorInput = context.args.color as string | undefined;
    const descInput = context.args.desc as string | undefined;

    let color: string | null = null;
    if (colorInput) {
      color = resolveColor(colorInput);
      if (!color) {
        console.error(
          `Error: Invalid color "${colorInput}". Use #RRGGBB or a palette name: ${Object.keys(COLOR_NAMES).join(", ")}`
        );
        process.exit(1);
      }
    }

    if (!timeInput) {
      console.error("Error: --at is required (events need a start time, e.g. --at 08:00)");
      process.exit(1);
    }

    const parsedTime = parseTime(timeInput);
    if (!parsedTime) {
      console.error(`Error: Invalid time format "${timeInput}". Expected HH:MM (e.g., 08:00, 14:30)`);
      process.exit(1);
    }

    let eventDate: string;
    if (today) {
      eventDate = getTodayDate();
    } else if (tomorrow) {
      eventDate = getTomorrowDate();
    } else if (dateInput) {
      const parsed = parseDate(dateInput);
      if (!parsed) {
        console.error(`Error: Could not parse date "${dateInput}"`);
        process.exit(1);
      }
      eventDate = parsed;
    } else {
      eventDate = getTodayDate();
    }

    let durationSeconds = DEFAULT_DURATION_SECONDS;
    if (durationInput) {
      try {
        durationSeconds = parseDurationToSeconds(durationInput);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Invalid duration format"}`);
        process.exit(1);
      }
    }

    const calendar = await resolveCalendar(client, calendarName);
    if (!calendar) {
      console.error(
        calendarName
          ? `Error: No writable calendar matching "${calendarName}"`
          : "Error: No writable calendar found on this account"
      );
      process.exit(1);
    }

    const startTime = createDateTimeUTC(eventDate, parsedTime.hours, parsedTime.minutes);
    const endTime = new Date(new Date(startTime).getTime() + durationSeconds * 1000).toISOString();
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const recurrence = recurrenceInput ? [recurrenceInput] : null;

    const event: CreateEventPayload = {
      id: eventId,
      title,
      description: descInput ?? "",
      start_time: startTime,
      end_time: endTime,
      start_datetime_tz: calendar.timezone ?? getLocalTimezone(),
      status: "confirmed",
      creator_id: calendar.origin_id,
      organizer_id: calendar.origin_id,
      connector_id: calendar.connector_id,
      akiflow_account_id: calendar.akiflow_account_id,
      origin_account_id: calendar.origin_account_id,
      calendar_id: calendar.id,
      origin_calendar_id: calendar.origin_id,
      // A recurring master self-references via recurring_id == id; without this
      // Google drops the RRULE and creates a single event.
      recurring_id: recurrence ? eventId : null,
      content: { sendUpdates: "all" },
      attendees: [],
      recurrence,
      color,
      read_only: false,
      global_updated_at: now,
    };

    try {
      const response = await client.upsertEvents([event]);
      const created = response.data?.[0];

      if (!created) {
        console.error("Error: Failed to create event - no data returned");
        process.exit(1);
      }

      console.log("✓ Event created successfully");
      console.log(`  ID: ${created.id}`);
      console.log(`  Title: ${created.title}`);
      console.log(`  Calendar: ${calendar.title}`);
      if (created.start_time && created.end_time) {
        console.log(`  When: ${eventDate} ${formatLocalTime(created.start_time)} - ${formatLocalTime(created.end_time)}`);
      }
      if (created.recurrence) {
        const rule = Array.isArray(created.recurrence) ? created.recurrence.join(", ") : created.recurrence;
        console.log(`  Recurrence: ${rule}`);
      }
      if (color) {
        console.log(`  Color: ${color}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AuthError") {
        console.error("Error: Authentication failed. Please run 'af auth' to login.");
      } else {
        console.error("Error: Failed to create event", error instanceof Error ? error.message : "Unknown error");
      }
      process.exit(1);
    }
  },
});

export const eventDeleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a calendar event by UUID (cancels it in the source calendar)",
  },
  args: {
    id: {
      type: "string",
      description: "Event UUID",
      required: true,
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const client = createClient();

    try {
      const response = await client.getEvents();
      const event = (response.data ?? []).find((e) => e.id === id);

      if (!event) {
        console.error(`Error: Event "${id}" not found`);
        process.exit(1);
      }

      const now = new Date().toISOString();
      const payload: DeleteEventPayload = {
        id: event.id,
        status: "cancelled",
        deleted_at: now,
        global_updated_at: now,
        calendar_id: event.calendar_id ?? undefined,
        connector_id: event.connector_id,
        akiflow_account_id: event.akiflow_account_id,
        origin_account_id: event.origin_account_id,
        origin_calendar_id: event.origin_calendar_id,
        content: { sendUpdates: "all" },
      };

      await client.upsertEvents([payload]);
      console.log(`✓ Deleted event "${id}" (${event.title ?? "untitled"})`);
    } catch (error) {
      if (error instanceof Error && error.name === "AuthError") {
        console.error("Error: Authentication failed. Please run 'af auth' to login.");
      } else {
        console.error("Error: Failed to delete event", error instanceof Error ? error.message : "Unknown error");
      }
      process.exit(1);
    }
  },
});

export const eventListCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List today's calendar events",
  },
  run: async () => {
    const client = createClient();

    try {
      const response = await client.getEvents();
      const today = getTodayDate();

      const events = (response.data ?? [])
        .filter((e) => !e.deleted_at && e.start_time)
        .filter((e) => {
          const local = new Date(e.start_time as string);
          const y = local.getFullYear();
          const m = String(local.getMonth() + 1).padStart(2, "0");
          const d = String(local.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}` === today;
        })
        .sort(
          (a, b) =>
            new Date(a.start_time as string).getTime() -
            new Date(b.start_time as string).getTime()
        );

      if (events.length === 0) {
        console.log("No events scheduled for today.");
        return;
      }

      for (const e of events) {
        const start = formatLocalTime(e.start_time as string);
        const end = e.end_time ? formatLocalTime(e.end_time) : "?";
        console.log(`${start}-${end}  ${e.title ?? "(untitled)"}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("Unknown error occurred");
      }
      process.exit(1);
    }
  },
});

export const eventCommand = defineCommand({
  meta: {
    name: "event",
    description: "Manage calendar events (Google/Outlook)",
  },
  subCommands: {
    add: eventAddCommand,
    delete: eventDeleteCommand,
    ls: eventListCommand,
  },
  run: async () => {
    console.log("Event subcommands:");
    console.log("  add    - Create a real calendar event");
    console.log("  delete - Delete an event by UUID");
    console.log("  ls     - List today's events");
  },
});
