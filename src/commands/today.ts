import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { Task, TimeSlot, CalendarEvent } from "../lib/api/types";

interface ScheduleItem {
  time: Date;
  endTime: Date;
  kind: "event" | "slot";
  title: string;
  slotId: string | null;
  tasks: Task[];
  recurring?: boolean;
}

function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function durStr(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

function isToday(iso: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return iso.startsWith(today);
}

export const today = defineCommand({
  meta: {
    name: "today",
    description: "Show today's full schedule: events, time slots, and tasks",
  },
  run: async () => {
    const client = createClient();

    let events: CalendarEvent[] = [];
    let slots: TimeSlot[] = [];
    let tasks: Task[] = [];

    try {
      const [evRes, slotRes, taskRes] = await Promise.all([
        client.getEvents({ withDeleted: false }),
        client.getTimeSlots({ limit: 2500 }),
        client.getTasks({ limit: 2500 }),
      ]);
      events = (evRes.data ?? []).filter(
        (e) => e.start_time && isToday(e.start_time) && e.status !== "cancelled"
      );
      slots = (slotRes.data ?? []).filter(
        (s) => s.start_time && isToday(s.start_time) && !s.deleted_at
      );
      tasks = (taskRes.data ?? []).filter(
        (t) => !t.deleted_at && !t.done && t.date === new Date().toISOString().slice(0, 10)
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AuthError") {
        console.error("Error: Authentication failed. Please run 'af auth' to login.");
      } else {
        console.error("Error: Failed to fetch schedule");
        if (error instanceof Error) console.error(error.message);
      }
      process.exit(1);
    }

    if (events.length === 0 && slots.length === 0 && tasks.length === 0) {
      console.log("Nothing scheduled today.");
      return;
    }

    const items: ScheduleItem[] = [];

    for (const e of events) {
      if (!e.start_time || !e.end_time) continue;
      items.push({
        time: new Date(e.start_time),
        endTime: new Date(e.end_time),
        kind: "event",
        title: e.title ?? "(untitled)",
        slotId: null,
        tasks: [],
        recurring: !!(e.recurrence && (Array.isArray(e.recurrence) ? e.recurrence.length : e.recurrence)),
      });
    }

    for (const s of slots) {
      const slotTasks = tasks.filter((t) => t.time_slot_id === s.id);
      items.push({
        time: new Date(s.start_time),
        endTime: new Date(s.end_time),
        kind: "slot",
        title: s.title,
        slotId: s.id,
        tasks: slotTasks,
      });
    }

    const slottedTaskIds = new Set(
      items.filter((i) => i.kind === "slot").flatMap((i) => i.tasks.map((t) => t.id))
    );
    const unslotted = tasks.filter((t) => !slottedTaskIds.has(t.id));

    items.sort((a, b) => a.time.getTime() - b.time.getTime());

    console.log(`📅 ${new Date().toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}\n`);

    for (const item of items) {
      const dur = durStr(item.endTime.getTime() - item.time.getTime());
      const icon = item.kind === "event" ? "📌" : "⏱";
      const rec = item.recurring ? " ↻" : "";

      if (item.kind === "event") {
        console.log(`${icon} ${fmt(item.time)}→${fmt(item.endTime)}  ${item.title} (${dur})${rec}`);
      } else if (item.tasks.length > 0) {
        console.log(`${icon} ${fmt(item.time)}→${fmt(item.endTime)}  (${dur})`);
        for (const t of item.tasks) {
          const check = t.done ? "✓" : "○";
          const recT = t.recurrence ? " ↻" : "";
          console.log(`   ${check} ${t.title}${recT}`);
        }
      } else {
        const orphan = tasks.length === 0 ? "  [orphan — no task]" : "";
        console.log(`${icon} ${fmt(item.time)}→${fmt(item.endTime)}  ${item.title} (${dur})${orphan}`);
      }
    }

    if (unslotted.length > 0) {
      console.log("\n📋 Today (no time block):");
      for (const t of unslotted) {
        const check = t.done ? "✓" : "○";
        const recT = t.recurrence ? " ↻" : "";
        console.log(`   ${check} ${t.title}${recT}`);
      }
    }
  },
});
