import { defineCommand } from "citty";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createClient } from "../../lib/api/client";
import type { CreateTaskPayload, CreateTimeSlotPayload, UpdateTaskPayload } from "../../lib/api/types";
import { parseDuration } from "../../lib/duration-parser";
import {
  parseDate,
  getTodayDate,
  parseTime,
  createDateTimeUTC,
  getLocalTimezone,
} from "../../lib/date-parser";
import { getDefaultCalendarId } from "../../lib/calendar";
import {
  normalizeRrule,
  extractRrule,
  rruleWithUntil,
  icalUntilDayBefore,
} from "../../lib/rrule";

interface ContextFile {
  tasks: Array<{
    shortId: number;
    id: string;
    title: string;
  }>;
  timestamp: number;
}

function getContextFilePath(): string {
  return join(homedir(), ".cache", "af", "last-list.json");
}

function readContextFile(): ContextFile | null {
  try {
    const path = getContextFilePath();
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as ContextFile;
  } catch {
    return null;
  }
}

function resolveTaskId(
  identifier: string,
  context: ContextFile | null
): string | null {
  // If identifier looks like a full UUID (36 chars with dashes), return it directly
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(identifier)) {
    return identifier;
  }

  // If no context, can't resolve short IDs or partial UUIDs
  if (!context) {
    return null;
  }

  const shortId = parseInt(identifier, 10);
  if (!isNaN(shortId)) {
    const task = context.tasks.find((t) => t.shortId === shortId);
    if (task) {
      return task.id;
    }
    return null;
  }

  const matchingTasks = context.tasks.filter((t) =>
    t.id.toLowerCase().startsWith(identifier.toLowerCase())
  );

  if (matchingTasks.length === 1) {
    return matchingTasks[0]!.id;
  }

  if (matchingTasks.length > 1) {
    console.error(
      `Error: Ambiguous UUID "${identifier}" matches ${matchingTasks.length} tasks`
    );
    return null;
  }

  return null;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Resolve a YYYY-MM-DD or natural-language date, defaulting to today when omitted. */
function resolveTargetDate(input: string | undefined): string | null {
  if (!input) return getTodayDate();
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[0];
  return parseDate(input);
}

/** Parse a --due value (YYYY-MM-DD or natural language) into a date string, or exit on failure. */
function parseDueOrExit(dueInput: string): string {
  const m = dueInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[0];
  const parsed = parseDate(dueInput);
  if (!parsed) {
    console.error(`Error: Could not parse due date "${dueInput}"`);
    process.exit(1);
  }
  return parsed;
}

/** The occurrence datetime (UTC ISO) for targetDate at the master's local time-of-day. */
function occurrenceDatetimeUTC(masterDatetime: string, targetDate: string): string {
  const d = new Date(masterDatetime);
  return createDateTimeUTC(targetDate, d.getHours(), d.getMinutes());
}

export const taskEditCommand = defineCommand({
  meta: {
    name: "edit",
    description:
      "Edit a task. For recurring tasks pass --scope this|following|all (this = one occurrence, all = whole series, following = this and future).",
  },
  args: {
    id: {
      type: "string",
      description: "Task ID (short ID or UUID)",
      required: true,
    },
    scope: {
      type: "string",
      description: "For recurring tasks: this (one occurrence) | following (this + future) | all (whole series)",
    },
    date: {
      type: "string",
      description: "Target occurrence date for --scope this|following (default: today)",
    },
    title: {
      type: "string",
      description: "New title",
    },
    due: {
      type: "string",
      description: "Deadline date (YYYY-MM-DD or natural language)",
    },
    desc: {
      type: "string",
      description: "Task description or notes",
    },
    link: {
      type: "string",
      description: "URL to attach to the task",
    },
    recurrence: {
      type: "string",
      description: "New repeat RRULE (only with --scope all|following)",
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const scopeInput = context.args.scope as string | undefined;
    const dateInput = context.args.date as string | undefined;
    const titleInput = context.args.title as string | undefined;
    const dueInput = context.args.due as string | undefined;
    const descInput = context.args.desc as string | undefined;
    const linkInput = context.args.link as string | undefined;
    const recurrenceInput = context.args.recurrence as string | undefined;
    const contextFile = readContextFile();

    const taskId = resolveTaskId(id, contextFile);
    if (!taskId) {
      console.error(`Error: Could not resolve task ID "${id}". Run 'af ls' first or provide a full UUID.`);
      process.exit(1);
    }

    const client = createClient();

    // Load the task to learn its recurrence context.
    let task;
    try {
      const response = await client.getTask(taskId);
      if (!response.success || !response.data) {
        console.error("Error: Failed to fetch task");
        process.exit(1);
      }
      task = response.data;
    } catch (error) {
      console.error("Error: Failed to fetch task");
      if (error instanceof Error) console.error(error.message);
      process.exit(1);
    }

    const isRecurring = !!(task.recurrence || task.recurring_id);
    const hasUpdates = !!(titleInput || dueInput || descInput || linkInput || recurrenceInput);

    if (!hasUpdates) {
      // Show current fields.
      console.log(`Task: ${task.title}`);
      console.log(`ID: ${task.id}`);
      console.log(`Description: ${task.description || "(none)"}`);
      console.log(`Date: ${task.date || "(not scheduled)"}`);
      console.log(`Due date: ${task.due_date || "(none)"}`);
      console.log(`Status: ${task.done ? "Done" : "Active"}`);
      console.log(`Priority: ${task.priority || "(none)"}`);
      console.log(`Duration: ${task.duration ? `${Math.floor(task.duration / 60)}m` : "(none)"}`);
      console.log(`Links: ${task.links && task.links.length > 0 ? task.links.join(", ") : "(none)"}`);
      console.log(`Project ID: ${task.listId || "(none)"}`);
      console.log(`Tags: ${task.tags_ids.length > 0 ? task.tags_ids.join(", ") : "(none)"}`);
      if (isRecurring) {
        const rule = extractRrule(task.recurrence);
        console.log(`Recurrence: ${rule ?? "(occurrence of a recurring series)"}`);
      }
      return;
    }

    const now = new Date().toISOString();
    const dueDate = dueInput ? parseDueOrExit(dueInput) : undefined;

    // --- Non-recurring task: plain field update (unchanged behavior). ---
    if (!isRecurring) {
      if (recurrenceInput) {
        console.error("Error: --recurrence edits a recurring task. Create one with 'af add --recurrence ... --at ...'.");
        process.exit(1);
      }
      const payload: UpdateTaskPayload = { id: taskId, global_updated_at: now };
      if (titleInput) payload.title = titleInput;
      if (dueDate) payload.due_date = dueDate;
      if (descInput) payload.description = descInput;
      if (linkInput) payload.links = [linkInput];
      try {
        const response = await client.upsertTasks([payload]);
        if (!response.success) {
          console.error("Error: Failed to update task");
          console.error(response.message);
          process.exit(1);
        }
        const updated = response.data[0];
        console.log(`✓ Updated task "${id}"`);
        if (titleInput) console.log(`  Title: ${updated?.title}`);
        if (dueInput) console.log(`  Deadline: ${updated?.due_date}`);
        if (descInput) console.log(`  Description: ${updated?.description}`);
        if (linkInput) console.log(`  Link: ${updated?.links?.[0]}`);
      } catch (error) {
        console.error("Error: Failed to update task");
        if (error instanceof Error) console.error(error.message);
        process.exit(1);
      }
      return;
    }

    // --- Recurring task: scope is required (prevents accidental whole-series edits). ---
    if (!scopeInput) {
      console.error(
        `Error: "${task.title}" is a recurring task. Specify --scope this|following|all (this = only one occurrence, all = whole series, following = this and future).`
      );
      process.exit(1);
    }
    const scope = scopeInput.toLowerCase();
    if (scope !== "this" && scope !== "following" && scope !== "all") {
      console.error(`Error: Invalid --scope "${scopeInput}". Use this, following, or all.`);
      process.exit(1);
    }

    const masterId = task.recurring_id ?? task.id;
    let master = task;
    if (masterId !== task.id) {
      try {
        const mr = await client.getTask(masterId);
        if (mr.success && mr.data) master = mr.data;
      } catch {
        // fall back to the task itself as the template
      }
    }

    // Validate --recurrence usage.
    let newRule: string | undefined;
    if (recurrenceInput) {
      if (scope === "this") {
        console.error("Error: --recurrence changes the repeat rule and cannot apply to a single occurrence (use --scope all or following).");
        process.exit(1);
      }
      const norm = normalizeRrule(recurrenceInput);
      if (!norm) {
        console.error(`Error: Invalid recurrence "${recurrenceInput}". Expected an RRULE, e.g. 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'`);
        process.exit(1);
      }
      newRule = norm;
    }

    // ---- scope: all — edit the master (whole series). ----
    if (scope === "all") {
      const payload: UpdateTaskPayload = { id: masterId, global_updated_at: now };
      if (titleInput) payload.title = titleInput;
      if (dueDate) payload.due_date = dueDate;
      if (descInput) payload.description = descInput;
      if (linkInput) payload.links = [linkInput];
      if (newRule) {
        payload.recurrence = [newRule];
        payload.recurrence_version = (master.recurrence_version ?? 1) + 1;
      }
      try {
        const response = await client.upsertTasks([payload]);
        if (!response.success) {
          console.error("Error: Failed to update series");
          console.error(response.message);
          process.exit(1);
        }
        console.log(`✓ Updated whole series "${master.title ?? id}"`);
        if (titleInput) console.log(`  Title: ${titleInput}`);
        if (descInput) console.log(`  Description: ${descInput}`);
        if (dueDate) console.log(`  Deadline: ${dueDate}`);
        if (linkInput) console.log(`  Link: ${linkInput}`);
        if (newRule) console.log(`  Recurrence: ${newRule}`);
      } catch (error) {
        console.error("Error: Failed to update series");
        if (error instanceof Error) console.error(error.message);
        process.exit(1);
      }
      return;
    }

    // this | following both target a specific occurrence date.
    const targetDate = resolveTargetDate(dateInput);
    if (!targetDate) {
      console.error(`Error: Could not parse date "${dateInput}"`);
      process.exit(1);
    }

    // ---- scope: this — override a single occurrence (an exception row). ----
    if (scope === "this") {
      let existing;
      try {
        const all = await client.getTasks({ limit: 2500 });
        existing = (all.data ?? []).find(
          (t) =>
            !t.deleted_at &&
            t.id !== masterId &&
            t.recurring_id === masterId &&
            (t.date === targetDate || t.original_date === targetDate)
        );
      } catch {
        // ignore — fall through to create
      }

      if (existing) {
        const payload: UpdateTaskPayload = { id: existing.id, global_updated_at: now };
        if (titleInput) payload.title = titleInput;
        if (dueDate) payload.due_date = dueDate;
        if (descInput) payload.description = descInput;
        if (linkInput) payload.links = [linkInput];
        try {
          const response = await client.upsertTasks([payload]);
          if (!response.success) {
            console.error("Error: Failed to update occurrence");
            console.error(response.message);
            process.exit(1);
          }
        } catch (error) {
          console.error("Error: Failed to update occurrence");
          if (error instanceof Error) console.error(error.message);
          process.exit(1);
        }
      } else {
        // Materialize an exception overriding this occurrence; other days inherit the master.
        const exceptionId = crypto.randomUUID();
        const datetime = master.datetime ? occurrenceDatetimeUTC(master.datetime, targetDate) : undefined;
        const exception: CreateTaskPayload = {
          id: exceptionId,
          title: titleInput ?? master.title ?? "",
          global_created_at: now,
          global_updated_at: now,
          recurring_id: masterId,
          date: targetDate,
          original_date: targetDate,
        };
        if (master.recurrence_version != null) exception.recurrence_version = master.recurrence_version;
        const desc = descInput ?? master.description;
        if (desc) exception.description = desc;
        if (master.duration != null) exception.duration = master.duration;
        if (dueDate) exception.due_date = dueDate;
        const links = linkInput ? [linkInput] : master.links;
        if (links && links.length > 0) exception.links = links;
        if (datetime) {
          exception.datetime = datetime;
          exception.original_datetime = datetime;
          exception.datetime_tz = master.datetime_tz ?? getLocalTimezone();
        }
        if (master.calendar_id) {
          exception.calendar_id = master.calendar_id;
          exception.status = master.status ?? 2;
        }
        if (master.listId) exception.listId = master.listId;

        try {
          const response = await client.upsertTasks([exception]);
          if (!response.success) {
            console.error("Error: Failed to create occurrence override");
            console.error(response.message);
            process.exit(1);
          }
        } catch (error) {
          console.error("Error: Failed to create occurrence override");
          if (error instanceof Error) console.error(error.message);
          process.exit(1);
        }
      }

      console.log(`✓ Updated the ${targetDate} occurrence of "${master.title ?? id}" (other days unchanged)`);
      if (titleInput) console.log(`  Title: ${titleInput}`);
      if (descInput) console.log(`  Description: ${descInput}`);
      if (dueDate) console.log(`  Deadline: ${dueDate}`);
      if (linkInput) console.log(`  Link: ${linkInput}`);
      return;
    }

    // ---- scope: following — split the series at targetDate. ----
    const currentRule = extractRrule(master.recurrence);
    if (!currentRule) {
      console.error("Error: Could not read the recurrence rule to split the series.");
      process.exit(1);
    }
    // 1) Cap the existing master to end the day before targetDate.
    const capPayload: UpdateTaskPayload = {
      id: masterId,
      global_updated_at: now,
      recurrence: [rruleWithUntil(currentRule, icalUntilDayBefore(targetDate))],
      recurrence_version: (master.recurrence_version ?? 1) + 1,
    };
    // 2) Create a new master from targetDate carrying the ongoing rule + overrides.
    const ongoingRule = newRule ?? currentRule.replace(/;?UNTIL=[^;]*/i, "");
    const newMasterId = crypto.randomUUID();
    const datetime = master.datetime ? occurrenceDatetimeUTC(master.datetime, targetDate) : undefined;
    const newMaster: CreateTaskPayload = {
      id: newMasterId,
      title: titleInput ?? master.title ?? "",
      global_created_at: now,
      global_updated_at: now,
      recurring_id: newMasterId,
      recurrence: [ongoingRule],
      recurrence_version: 2,
      date: targetDate,
    };
    const desc = descInput ?? master.description;
    if (desc) newMaster.description = desc;
    if (master.duration != null) newMaster.duration = master.duration;
    if (dueDate) newMaster.due_date = dueDate;
    const links = linkInput ? [linkInput] : master.links;
    if (links && links.length > 0) newMaster.links = links;
    if (datetime) {
      newMaster.datetime = datetime;
      newMaster.datetime_tz = master.datetime_tz ?? getLocalTimezone();
    }
    if (master.calendar_id) {
      newMaster.calendar_id = master.calendar_id;
      newMaster.status = master.status ?? 2;
    }
    if (master.listId) newMaster.listId = master.listId;

    try {
      const response = await client.upsertTasks([capPayload, newMaster]);
      if (!response.success) {
        console.error("Error: Failed to split the series");
        console.error(response.message);
        process.exit(1);
      }
      console.log(`✓ Updated "${master.title ?? id}" from ${targetDate} onward (earlier occurrences unchanged)`);
      console.log(`  New series id: ${newMasterId}`);
      if (titleInput) console.log(`  Title: ${titleInput}`);
      if (descInput) console.log(`  Description: ${descInput}`);
      if (newRule) console.log(`  Recurrence: ${ongoingRule}`);
    } catch (error) {
      console.error("Error: Failed to split the series");
      if (error instanceof Error) console.error(error.message);
      process.exit(1);
    }
  },
});

export const taskMoveCommand = defineCommand({
  meta: {
    name: "move",
    description: "Move task to a project",
  },
  args: {
    id: {
      type: "string",
      description: "Task ID (short ID or UUID)",
      required: true,
    },
    project: {
      type: "string",
      description: "Project ID to move task to",
      required: true,
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const projectId = context.args.project as string;
    const contextFile = readContextFile();

    const taskId = resolveTaskId(id, contextFile);
    if (!taskId) {
      console.error(`Error: Could not resolve task ID "${id}". Run 'af ls' first or provide a full UUID.`);
      process.exit(1);
    }

    const client = createClient();
    const timestamp = new Date().toISOString();

    const updatePayload: UpdateTaskPayload = {
      id: taskId,
      listId: projectId,
      global_updated_at: timestamp,
    };

    try {
      const response = await client.upsertTasks([updatePayload]);

      if (response.success) {
        console.log(`✓ Moved task "${id}" to project "${projectId}"`);
      } else {
        console.error("Error: Failed to move task");
        console.error(response.message);
        process.exit(1);
      }
    } catch (error) {
      console.error("Error: Failed to move task");
      if (error instanceof Error) {
        console.error(error.message);
      }
      process.exit(1);
    }
  },
});

export const taskPlanCommand = defineCommand({
  meta: {
    name: "plan",
    description: "Schedule task for a specific date",
  },
  args: {
    id: {
      type: "string",
      description: "Task ID (short ID or UUID)",
      required: true,
    },
    date: {
      type: "string",
      description: "Date to schedule task (YYYY-MM-DD or natural language)",
      required: false,
    },
    at: {
      type: "string",
      description: "Time for scheduling (e.g., 21:00, 14:30)",
      required: false,
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const dateArg = context.args.date as string | undefined;
    const atArg = context.args.at as string | undefined;
    const contextFile = readContextFile();

    const taskId = resolveTaskId(id, contextFile);
    if (!taskId) {
      console.error(`Error: Could not resolve task ID "${id}". Run 'af ls' first or provide a full UUID.`);
      process.exit(1);
    }

    let dateStr: string;

    if (dateArg) {
      const dateMatch = dateArg.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        dateStr = dateMatch[0];
      } else {
        const parsedDate = parseDate(dateArg);
        if (parsedDate) {
          dateStr = parsedDate;
        } else {
          console.error(`Error: Invalid date format "${dateArg}". Use YYYY-MM-DD or natural language (e.g., "today", "tomorrow", "next friday").`);
          process.exit(1);
        }
      }
    } else if (atArg) {
      dateStr = getTodayDate();
    } else {
      console.error("Error: Either --date or --at must be specified.");
      process.exit(1);
    }

    const scheduledDate = new Date(dateStr);
    if (isNaN(scheduledDate.getTime())) {
      console.error(`Error: Invalid date "${dateArg}"`);
      process.exit(1);
    }

    const client = createClient();
    const timestamp = new Date().toISOString();

    const updatePayload: UpdateTaskPayload = {
      id: taskId,
      date: dateStr,
      global_updated_at: timestamp,
    };

    if (atArg) {
      const parsedTime = parseTime(atArg);
      if (!parsedTime) {
        console.error(`Error: Invalid time format "${atArg}". Use HH:MM format (e.g., "21:00", "14:30").`);
        process.exit(1);
      }

      const datetime = createDateTimeUTC(dateStr, parsedTime.hours, parsedTime.minutes);
      updatePayload.datetime = datetime;
      updatePayload.datetime_tz = getLocalTimezone();
      updatePayload.status = 2;

      const calendarId = await getDefaultCalendarId(client);
      if (calendarId) {
        const slotId = crypto.randomUUID();
        const nowISO = new Date().toISOString();
        const endISO = new Date(new Date(datetime).getTime() + 1800 * 1000).toISOString();

        const slot: CreateTimeSlotPayload = {
          id: slotId,
          title: "",
          start_time: datetime,
          end_time: endISO,
          start_datetime_tz: getLocalTimezone(),
          status: "confirmed",
          calendar_id: calendarId,
          data: {},
          recurring_id: null,
          label_id: null,
          section_id: null,
          recurrence: null,
          global_created_at: nowISO,
          global_updated_at: nowISO,
        };

        try {
          await client.upsertTimeSlots([slot]);
          updatePayload.time_slot_id = slotId;
        } catch {
          // Slot creation failed — still set the datetime/status on the task.
        }
      }
    }

    try {
      const response = await client.upsertTasks([updatePayload]);

      if (response.success) {
        if (atArg) {
          console.log(`✓ Scheduled task "${id}" for ${dateStr} at ${atArg}`);
        } else {
          console.log(`✓ Scheduled task "${id}" for ${dateStr}`);
        }
      } else {
        console.error("Error: Failed to schedule task");
        console.error(response.message);
        process.exit(1);
      }
    } catch (error) {
      console.error("Error: Failed to schedule task");
      if (error instanceof Error) {
        console.error(error.message);
      }
      process.exit(1);
    }
  },
});

export const taskSnoozeCommand = defineCommand({
  meta: {
    name: "snooze",
    description: "Push task back by a duration (e.g., 1h, 2d, 1w)",
  },
  args: {
    id: {
      type: "string",
      description: "Task ID (short ID or UUID)",
      required: true,
    },
    duration: {
      type: "string",
      description: "Duration to snooze (e.g., 1h, 2d, 1w)",
      required: true,
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const durationArg = context.args.duration as string;
    const contextFile = readContextFile();

    const taskId = resolveTaskId(id, contextFile);
    if (!taskId) {
      console.error(`Error: Could not resolve task ID "${id}". Run 'af ls' first or provide a full UUID.`);
      process.exit(1);
    }

    let snoozeDuration: number;
    try {
      snoozeDuration = parseDuration(durationArg);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Invalid duration"}`);
      process.exit(1);
    }

    const client = createClient();
    const allTasksResponse = await client.getTasks();
    if (!allTasksResponse.success || !allTasksResponse.data) {
      console.error("Error: Failed to fetch tasks");
      process.exit(1);
    }

    const task = allTasksResponse.data.find((t) => t.id === taskId);
    if (!task) {
      console.error(`Error: Task with ID "${taskId}" not found`);
      process.exit(1);
    }

    let baseDate = task.date ? new Date(task.date) : new Date();
    if (isNaN(baseDate.getTime())) {
      baseDate = new Date();
    }

    const newDate = new Date(baseDate.getTime() + snoozeDuration);
    const dateStr = formatDate(newDate);
    const timestamp = new Date().toISOString();

    const updatePayload: UpdateTaskPayload = {
      id: taskId,
      date: dateStr,
      global_updated_at: timestamp,
    };

    try {
      const response = await client.upsertTasks([updatePayload]);

      if (response.success) {
        console.log(`✓ Snoozed task "${id}" to ${dateStr}`);
      } else {
        console.error("Error: Failed to snooze task");
        console.error(response.message);
        process.exit(1);
      }
    } catch (error) {
      console.error("Error: Failed to snooze task");
      if (error instanceof Error) {
        console.error(error.message);
      }
      process.exit(1);
    }
  },
});

export const taskDeleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Soft delete a task",
  },
  args: {
    id: {
      type: "string",
      description: "Task ID (short ID or UUID)",
      required: true,
    },
  },
  run: async (context) => {
    const id = context.args.id as string;
    const contextFile = readContextFile();

    const taskId = resolveTaskId(id, contextFile);
    if (!taskId) {
      console.error(`Error: Could not resolve task ID "${id}". Run 'af ls' first or provide a full UUID.`);
      process.exit(1);
    }

    const client = createClient();
    const timestamp = new Date().toISOString();

    const updatePayload: UpdateTaskPayload = {
      id: taskId,
      deleted_at: timestamp,
      global_updated_at: timestamp,
    };

    try {
      const response = await client.upsertTasks([updatePayload]);

      if (response.success) {
        console.log(`✓ Deleted task "${id}"`);
      } else {
        console.error("Error: Failed to delete task");
        console.error(response.message);
        process.exit(1);
      }
    } catch (error) {
      console.error("Error: Failed to delete task");
      if (error instanceof Error) {
        console.error(error.message);
      }
      process.exit(1);
    }
  },
});

export const taskCommand = defineCommand({
  meta: {
    name: "task",
    description: "Task management subcommands",
  },
  subCommands: {
    edit: taskEditCommand,
    move: taskMoveCommand,
    plan: taskPlanCommand,
    snooze: taskSnoozeCommand,
    delete: taskDeleteCommand,
  },
  run: async () => {
    console.log("Task management subcommands:");
    console.log("  edit   - Edit a task or recurring series (--scope this|following|all)");
    console.log("  move   - Move task to a project");
    console.log("  plan   - Schedule task for a specific date");
    console.log("  snooze - Push task back by a duration");
    console.log("  delete - Soft delete a task");
  },
});
