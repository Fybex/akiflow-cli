import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { CreateTimeSlotPayload } from "../lib/api/types";

export const slotCommand = defineCommand({
  meta: {
    name: "slot",
    description: "List and delete time slots",
  },
  subCommands: {
    ls: defineCommand({
      meta: {
        name: "ls",
        description: "List time slots for a date (default: today)",
      },
      args: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format (default: today)",
          alias: "d",
        },
      },
      run: async (context) => {
        const client = createClient();
        const dateInput = context.args.date as string | undefined;
        const targetDate = dateInput || new Date().toISOString().slice(0, 10);

        const response = await client.getTimeSlots({ limit: 2500 });
        const slots = (response.data ?? []).filter(
          (s) => s.start_time?.startsWith(targetDate) && !s.deleted_at
        );

        if (slots.length === 0) {
          console.log(`No time slots for ${targetDate}`);
          return;
        }

        slots.sort((a, b) => a.start_time.localeCompare(b.start_time));

        for (const s of slots) {
          const start = new Date(s.start_time);
          const end = new Date(s.end_time);
          const fmt = (d: Date) =>
            `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          const dur = Math.round((end.getTime() - start.getTime()) / 60000);
          const durStr = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60 > 0 ? ` ${dur % 60}m` : ""}` : `${dur}m`;
          const label = s.label_id ? `  label=${s.label_id.slice(0, 8)}` : "";
          console.log(`${s.id.slice(0, 8)}  ${fmt(start)}→${fmt(end)}  ${durStr}  "${s.title}"${label}`);
        }
        console.log(`\nTotal: ${slots.length} slots`);
      },
    }),
    delete: defineCommand({
      meta: {
        name: "delete",
        description: "Delete a time slot by ID",
      },
      args: {
        id: {
          type: "positional",
          description: "Time slot ID (8-char prefix or full UUID)",
          required: true,
        },
        force: {
          type: "boolean",
          description: "Delete even if tasks are still stacked in the slot (orphans their time_slot_id)",
          alias: "f",
        },
      },
      run: async (context) => {
        const client = createClient();
        const idInput = context.args.id as string;
        const force = context.args.force as boolean;

        const response = await client.getTimeSlots({ limit: 2500 });
        const slots = response.data ?? [];
        const slot = slots.find(
          (s) => s.id === idInput || s.id.startsWith(idInput)
        );

        if (!slot) {
          console.error(`Error: Time slot "${idInput}" not found`);
          process.exit(1);
        }

        // Warn (and refuse without --force) if the slot still has stacked tasks —
        // deleting a slot orphans those tasks with a dangling time_slot_id, which
        // is the same Akiflow state that produced the "null" cells on the grid.
        const allTasks = await client.getAllTasks();
        const stacked = allTasks.filter(
          (t) => t.time_slot_id === slot.id && !t.deleted_at
        );
        if (stacked.length > 0 && !force) {
          console.error(
            `Error: slot ${slot.id.slice(0, 8)} still has ${stacked.length} stacked task(s). Pass --force to delete anyway (orphans their time_slot_id).`
          );
          for (const t of stacked) {
            console.error(`  - ${t.title || "(no title)"} [${t.id.slice(0, 8)}]`);
          }
          process.exit(1);
        }

        const now = new Date().toISOString();
        const deletePayload: CreateTimeSlotPayload = {
          ...slot,
          id: slot.id,
          title: slot.title,
          start_time: slot.start_time,
          end_time: slot.end_time,
          start_datetime_tz: slot.start_datetime_tz,
          status: slot.status,
          calendar_id: slot.calendar_id,
          global_created_at: slot.global_created_at,
          global_updated_at: now,
          deleted_at: now,
        };

        try {
          await client.upsertTimeSlots([deletePayload]);
          console.log(`✓ Deleted slot "${slot.id.slice(0, 8)}" (${slot.title})`);
          if (stacked.length > 0) {
            console.error(
              `Warning: ${stacked.length} task(s) left with dangling time_slot_id. Run 'af task unschedule <id>' on each to clean up.`
            );
          }
        } catch (error) {
          console.error("Error: Failed to delete slot");
          if (error instanceof Error) console.error(error.message);
          process.exit(1);
        }
      },
    }),
  },
  run: async () => {
    console.log("Time slot commands:");
    console.log("  ls     - List time slots for a date");
    console.log("  delete - Delete a time slot by ID");
  },
});
