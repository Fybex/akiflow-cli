import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { CreateTaskPayload } from "../lib/api/types";
import { getTodayDate, getTomorrowDate, parseDate, parseTime, createDateTimeUTC, getLocalTimezone } from "../lib/date-parser";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { addPendingTask } from "../lib/task-cache";
import { getDefaultCalendarId } from "../lib/calendar";
import { normalizeRrule } from "../lib/rrule";

export const add = defineCommand({
  meta: {
    name: "add",
    description: "Create a new task",
  },
  args: {
    title: {
      type: "positional",
      description: "Task title",
      required: true,
    },
    today: {
      type: "boolean",
      description: "Schedule task for today",
      alias: "t",
    },
    tomorrow: {
      type: "boolean",
      description: "Schedule task for tomorrow",
    },
    date: {
      type: "string",
      description: "Natural language date (e.g., 'next friday', 'in 3 days')",
      alias: "d",
    },
    project: {
      type: "string",
      description: "Assign to project/label by name",
      alias: "p",
    },
    at: {
      type: "string",
      description: "Time for time block (e.g., '21:00', '14:30')",
    },
    duration: {
      type: "string",
      description: "Duration for time block (e.g., '30m', '1h', '2h')",
    },
    recurrence: {
      type: "string",
      description: "Recurring RRULE (e.g., 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'). Creates a repeating task.",
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
  },
  run: async (context) => {
    const client = createClient();

    const title = context.args.title as string;
    const today = context.args.today as boolean;
    const tomorrow = context.args.tomorrow as boolean;
    const dateInput = context.args.date as string | undefined;
    const projectName = context.args.project as string | undefined;
    const timeInput = context.args.at as string | undefined;
    const durationInput = context.args.duration as string | undefined;
    const recurrenceInput = context.args.recurrence as string | undefined;
    const dueInput = context.args.due as string | undefined;
    const descInput = context.args.desc as string | undefined;
    const linkInput = context.args.link as string | undefined;

    // Guard: only one date flag may set the day; the if/else chain below silently
    // discards the others, landing the task on the wrong day with no feedback.
    const dateFlagCount = [today, tomorrow, dateInput !== undefined].filter(Boolean).length;
    if (dateFlagCount > 1) {
      console.error("Error: Conflicting date flags. Use only one of --today, --tomorrow, or --date.");
      process.exit(1);
    }

    // Guard: a recurring task must be planned to a time. Without --at it has a date
    // but no datetime, and Akiflow renders it as many duplicate undated inbox items
    // (one per occurrence) instead of one repeating planned task.
    if (recurrenceInput && !timeInput) {
      console.error(
        "Error: --recurrence requires --at (a recurring task must be planned to a time, e.g. --at 09:00). Without a time Akiflow creates duplicate undated inbox items."
      );
      process.exit(1);
    }

    // Guard: duration sizes a time block; without --at there is no block to size
    // and the duration is silently dropped or attached to a non-block.
    if (durationInput && !timeInput) {
      console.error("Error: --duration requires --at (duration sizes a time block and is meaningless without a start time).");
      process.exit(1);
    }

    let taskDate: string | undefined;
    let taskDateTime: string | undefined;
    let taskDateTimeTz: string | undefined;
    let taskDuration: number | undefined;
    let calendarId: string | null = null;

    if (today) {
      taskDate = getTodayDate();
    } else if (tomorrow) {
      taskDate = getTomorrowDate();
    } else if (dateInput) {
      const parsedDate = parseDate(dateInput);
      if (!parsedDate) {
        console.error(`Error: Could not parse date "${dateInput}"`);
        process.exit(1);
      }
      taskDate = parsedDate;
    }

    if (timeInput) {
      const parsedTime = parseTime(timeInput);
      if (!parsedTime) {
        console.error(`Error: Invalid time format "${timeInput}". Expected format: HH:MM (e.g., 21:00, 14:30)`);
        process.exit(1);
      }

      if (!taskDate) {
        taskDate = getTodayDate();
      }

      taskDateTime = createDateTimeUTC(taskDate, parsedTime.hours, parsedTime.minutes);
      taskDateTimeTz = getLocalTimezone();
      calendarId = await getDefaultCalendarId(client);

      // Guard: a timed task needs a calendar to render as a visible block. Without one
      // it gets a datetime but no calendar_id / status:2, becoming a silent invisible block.
      if (!calendarId) {
        console.error(
          "Error: --at needs a default calendar but none could be resolved. Run 'af auth' and ensure you have a writable calendar with time slots before creating a timed task."
        );
        process.exit(1);
      }
    }

    if (durationInput) {
      try {
        taskDuration = parseDurationToSeconds(durationInput);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Invalid duration format"}`);
        process.exit(1);
      }
    }

    let recurrenceRules: string[] | undefined;
    if (recurrenceInput) {
      const normalized = normalizeRrule(recurrenceInput);
      if (!normalized) {
        console.error(
          `Error: Invalid recurrence "${recurrenceInput}". Expected an RRULE, e.g. 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'`
        );
        process.exit(1);
      }
      recurrenceRules = [normalized];
      // Recurrence needs an anchor date; default to today if none given.
      if (!taskDate) {
        taskDate = getTodayDate();
      }
    }

    let listId: string | undefined;
    if (projectName) {
      try {
        const labelsResponse = await client.getLabels();
        const label = labelsResponse.data.find(
          (l) => l.title.toLowerCase() === projectName.toLowerCase()
        );

        if (label) {
          listId = label.id;
        } else {
          console.error(`Error: Project "${projectName}" not found`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`Error: Failed to fetch projects`);
        console.error(error instanceof Error ? error.message : "Unknown error");
        process.exit(1);
      }
    }

    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();

    const task: CreateTaskPayload = {
      id: taskId,
      title,
      global_created_at: now,
      global_updated_at: now,
    };

    if (taskDate) {
      task.date = taskDate;
    }

    if (taskDateTime) {
      task.datetime = taskDateTime;
    }

    if (taskDateTimeTz) {
      task.datetime_tz = taskDateTimeTz;
    }

    if (taskDuration !== undefined) {
      task.duration = taskDuration;
    }

    if (listId) {
      task.listId = listId;
    }

    if (calendarId) {
      task.calendar_id = calendarId;
      task.status = 2; // Time-blocked status
    }

    if (dueInput) {
      const dueDateMatch = dueInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dueDateMatch) {
        task.due_date = dueDateMatch[0];
      } else {
        const parsedDue = parseDate(dueInput);
        if (!parsedDue) {
          console.error(`Error: Could not parse due date "${dueInput}"`);
          process.exit(1);
        }
        task.due_date = parsedDue;
      }
    }

    if (descInput) {
      task.description = descInput;
    }

    if (linkInput) {
      task.links = [linkInput];
    }

    if (recurrenceRules) {
      task.recurrence = recurrenceRules;
      // A recurring master self-references via recurring_id == id (same as events);
      // recurrence_version 2 matches Akiflow's current recurrence format.
      task.recurring_id = taskId;
      task.recurrence_version = 2;
      if (!task.datetime_tz) {
        task.datetime_tz = getLocalTimezone();
      }
    }

    try {
      const response = await client.upsertTasks([task]);
      const createdTask = response.data[0];

      if (!createdTask) {
        console.error("Error: Failed to create task - no data returned");
        process.exit(1);
      }

      // Save to pending cache for immediate visibility in ls
      await addPendingTask(createdTask);

      console.log("✓ Task created successfully");
      console.log(`  ID: ${createdTask.id}`);
      console.log(`  Title: ${createdTask.title}`);

      if (createdTask.date) {
        console.log(`  Date: ${createdTask.date}`);
      }

      if (createdTask.datetime) {
        const localTime = new Date(createdTask.datetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        console.log(`  Time: ${localTime}`);
      }

      if (createdTask.duration) {
        const minutes = Math.floor(createdTask.duration / 60);
        const durationStr = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
        console.log(`  Duration: ${durationStr}`);
      }

      if (createdTask.due_date) {
        console.log(`  Deadline: ${createdTask.due_date}`);
      }

      if (createdTask.description) {
        console.log(`  Description: ${createdTask.description}`);
      }

      if (createdTask.links && createdTask.links.length > 0) {
        console.log(`  Link: ${createdTask.links[0]}`);
      }

      if (createdTask.recurrence) {
        const rule = Array.isArray(createdTask.recurrence)
          ? createdTask.recurrence.join(", ")
          : createdTask.recurrence;
        console.log(`  Recurrence: ${rule}`);
      }

      if (createdTask.listId && listId) {
        console.log(`  Project: ${projectName}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AuthError") {
        console.error(
          "Error: Authentication failed. Please run 'af auth' to login."
        );
      } else {
        console.error(
          "Error: Failed to create task",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
      process.exit(1);
    }
  },
});
