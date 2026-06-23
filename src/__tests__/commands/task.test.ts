import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { taskPlanCommand, taskUnscheduleCommand } from "../../commands/task/index";
import * as storage from "../../lib/auth/storage";
import * as calendar from "../../lib/calendar";
import * as fs from "node:fs";

const mockCredentials = {
  token: "test-jwt-token",
  clientId: "test-client-id-12345",
  expiryTimestamp: Date.now() + 86400000,
};

const mockContextFile = {
  tasks: [
    { shortId: 1, id: "task-uuid-1", title: "Task 1" },
    { shortId: 2, id: "task-uuid-2", title: "Task 2" },
  ],
  timestamp: Date.now(),
};

/**
 * Build a chainable fetch mock: each call gets the next entry from `responses`.
 * Each Response can only be read once, so we factory a fresh one per call to
 * avoid "Body already used" errors when plan/schedule issue multiple calls
 * (e.g. GET /v5/tasks/<id> then PATCH /v5/tasks).
 */
function chainableFetch(responses: Array<unknown>): typeof fetch {
  let i = 0;
  return (async () => {
    const body = responses[i++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("taskPlanCommand", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let loadCredentialsSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let getDefaultCalendarIdSpy: ReturnType<typeof spyOn>;

  // GET /v5/tasks/<id> response — task plan does this when --at is passed to
  // fetch the task's duration / existing time_slot before rescheduling.
  const getTaskResponse = {
    success: true,
    message: null,
    data: {
      id: "task-uuid-1",
      title: "Task 1",
      duration: 1800,
      time_slot_id: null,
      date: "2026-02-10",
    },
  };

  // PATCH /v5/tasks response
  const patchResponse = {
    success: true,
    message: null,
    data: [{ id: "task-uuid-1", date: "2026-02-10" }],
  };

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(mockCredentials);
    readFileSyncSpy = spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(mockContextFile));
    // Default: no writable calendar — keeps plan on the simple branch (no
    // getCalendars / upsertTimeSlots calls), so each test only needs to mock
    // 1 or 2 fetches (just upsertTasks, or getTask + upsertTasks).
    getDefaultCalendarIdSpy = spyOn(calendar, "getDefaultCalendarId").mockResolvedValue(null);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    loadCredentialsSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    getDefaultCalendarIdSpy.mockRestore();
  });

  it("schedules task with YYYY-MM-DD date format", async () => {
    // given
    fetchSpy.mockImplementation(chainableFetch([patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "2026-02-10", at: undefined, _: [] },
      rawArgs: [],
    } as any);

    // then
    expect(fetchSpy).toHaveBeenCalled();
    const fetchCall = fetchSpy.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1]?.body as string);
    expect(requestBody[0].date).toBe("2026-02-10");
    expect(requestBody[0].datetime).toBeUndefined();
    expect(requestBody[0].datetime_tz).toBeUndefined();
    expect(consoleLogSpy).toHaveBeenCalledWith('✓ Scheduled task "task-uuid-1" for 2026-02-10');

    consoleLogSpy.mockRestore();
  });

  it("schedules task with natural language date 'today'", async () => {
    // given
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    fetchSpy.mockImplementation(chainableFetch([patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "today", at: undefined, _: [] },
      rawArgs: [],
    } as any);

    // then
    const fetchCall = fetchSpy.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1]?.body as string);
    expect(requestBody[0].date).toBe(expectedDate);
    expect(consoleLogSpy).toHaveBeenCalledWith(`✓ Scheduled task "task-uuid-1" for ${expectedDate}`);

    consoleLogSpy.mockRestore();
  });

  it("schedules task with natural language date 'tomorrow'", async () => {
    // given
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expectedDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    fetchSpy.mockImplementation(chainableFetch([patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "tomorrow", at: undefined, _: [] },
      rawArgs: [],
    } as any);

    // then
    const fetchCall = fetchSpy.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1]?.body as string);
    expect(requestBody[0].date).toBe(expectedDate);
    expect(consoleLogSpy).toHaveBeenCalledWith(`✓ Scheduled task "task-uuid-1" for ${expectedDate}`);

    consoleLogSpy.mockRestore();
  });

  it("schedules task with date and time (sizes slot from task duration)", async () => {
    // given — with --at, plan issues GET /v5/tasks/<id> first to learn duration
    fetchSpy.mockImplementation(chainableFetch([getTaskResponse, patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "2026-02-10", at: "21:00", _: [] },
      rawArgs: [],
    } as any);

    // then
    expect(fetchSpy).toHaveBeenCalledTimes(2); // GET task + PATCH tasks
    const getCall = fetchSpy.mock.calls[0];
    expect(getCall[0]).toContain("/v5/tasks/task-uuid-1");
    const patchCall = fetchSpy.mock.calls[1];
    const requestBody = JSON.parse(patchCall[1]?.body as string);
    expect(requestBody[0].date).toBe("2026-02-10");
    expect(requestBody[0].datetime).toBeTruthy();
    expect(requestBody[0].datetime_tz).toBeTruthy();
    expect(consoleLogSpy).toHaveBeenCalledWith('✓ Scheduled task "task-uuid-1" for 2026-02-10 at 21:00');

    consoleLogSpy.mockRestore();
  });

  it("schedules task with 'today' and time", async () => {
    // given
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    fetchSpy.mockImplementation(chainableFetch([getTaskResponse, patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "today", at: "14:30", _: [] },
      rawArgs: [],
    } as any);

    // then
    const patchCall = fetchSpy.mock.calls[1];
    const requestBody = JSON.parse(patchCall[1]?.body as string);
    expect(requestBody[0].date).toBe(expectedDate);
    expect(requestBody[0].datetime).toBeTruthy();
    expect(requestBody[0].datetime_tz).toBeTruthy();
    expect(consoleLogSpy).toHaveBeenCalledWith(`✓ Scheduled task "task-uuid-1" for ${expectedDate} at 14:30`);

    consoleLogSpy.mockRestore();
  });

  it("schedules task with 'tomorrow' and time", async () => {
    // given
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expectedDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    fetchSpy.mockImplementation(chainableFetch([getTaskResponse, patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: "tomorrow", at: "09:00", _: [] },
      rawArgs: [],
    } as any);

    // then
    const patchCall = fetchSpy.mock.calls[1];
    const requestBody = JSON.parse(patchCall[1]?.body as string);
    expect(requestBody[0].date).toBe(expectedDate);
    expect(requestBody[0].datetime).toBeTruthy();
    expect(requestBody[0].datetime_tz).toBeTruthy();
    expect(consoleLogSpy).toHaveBeenCalledWith(`✓ Scheduled task "task-uuid-1" for ${expectedDate} at 09:00`);

    consoleLogSpy.mockRestore();
  });

  it("defaults to today when only --at is specified", async () => {
    // given
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    fetchSpy.mockImplementation(chainableFetch([getTaskResponse, patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskPlanCommand.run({
      args: { id: "task-uuid-1", date: undefined, at: "16:30", _: [] },
      rawArgs: [],
    } as any);

    // then
    const patchCall = fetchSpy.mock.calls[1];
    const requestBody = JSON.parse(patchCall[1]?.body as string);
    expect(requestBody[0].date).toBe(expectedDate);
    expect(requestBody[0].datetime).toBeTruthy();
    expect(requestBody[0].datetime_tz).toBeTruthy();
    expect(consoleLogSpy).toHaveBeenCalledWith(`✓ Scheduled task "task-uuid-1" for ${expectedDate} at 16:30`);

    consoleLogSpy.mockRestore();
  });

  it("exits with error for invalid date format", async () => {
    // given
    const consoleErrorSpy = spyOn(console, "error");
    const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    // when/then
    await expect(
      taskPlanCommand.run({
        args: { id: "task-uuid-1", date: "invalid-date", at: undefined, _: [] },
        rawArgs: [],
      } as any)
    ).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid date format"));

    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("exits with error for invalid time format", async () => {
    // given
    const consoleErrorSpy = spyOn(console, "error");
    const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    // when/then
    await expect(
      taskPlanCommand.run({
        args: { id: "task-uuid-1", date: "2026-02-10", at: "invalid", _: [] },
        rawArgs: [],
      } as any)
    ).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid time format"));

    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("exits with error when neither date nor at is specified", async () => {
    // given
    const consoleErrorSpy = spyOn(console, "error");
    const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    // when/then
    await expect(
      taskPlanCommand.run({
        args: { id: "task-uuid-1", date: undefined, at: undefined, _: [] },
        rawArgs: [],
      } as any)
    ).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledWith("Error: Either --date or --at must be specified.");

    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });
});

describe("taskUnscheduleCommand", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let loadCredentialsSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let getAllTasksSpy: ReturnType<typeof spyOn>;

  const getTaskResponse = {
    success: true,
    message: null,
    data: {
      id: "task-uuid-1",
      title: "Task 1",
      date: "2026-02-10",
      datetime: "2026-02-10T10:00:00.000Z",
      time_slot_id: "slot-1",
    },
  };
  const patchResponse = {
    success: true,
    message: null,
    data: [{ id: "task-uuid-1", time_slot_id: null, datetime: null }],
  };

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(mockCredentials);
    readFileSyncSpy = spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(mockContextFile));
    // Skip the real /v5/tasks list call by mocking getAllTasks directly.
    getAllTasksSpy = spyOn(require("../../lib/api/client").AkiflowClient.prototype, "getAllTasks")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    loadCredentialsSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    getAllTasksSpy.mockRestore();
  });

  it("removes a task from its time slot and keeps the slot by default", async () => {
    // given
    fetchSpy.mockImplementation(chainableFetch([getTaskResponse, patchResponse]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskUnscheduleCommand.run({
      args: { id: "task-uuid-1", deleteSlot: undefined, _: [] },
      rawArgs: [],
    } as any);

    // then
    expect(fetchSpy).toHaveBeenCalled();
    const patchCall = fetchSpy.mock.calls[1];
    const requestBody = JSON.parse(patchCall[1]?.body as string);
    expect(requestBody[0].time_slot_id).toBeNull();
    expect(requestBody[0].datetime).toBeNull();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("kept on 2026-02-10"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("kept; pass --delete-slot"));

    consoleLogSpy.mockRestore();
  });

  it("soft-deletes the now-empty slot when --delete-slot is passed", async () => {
    // given — sequence: GET task, PATCH task, getAllTasks (mocked), getTimeSlot, PATCH slot
    const slotFetch = {
      success: true,
      message: null,
      data: [{
        id: "slot-1", user_id: 1, recurring_id: null, calendar_id: "cal1",
        label_id: null, section_id: null, status: "confirmed", title: "Old slot",
        description: null, original_start_time: null,
        start_time: "2026-02-10T10:00:00.000Z", end_time: "2026-02-10T11:00:00.000Z",
        start_datetime_tz: "UTC", recurrence: null, color: null, content: {},
        global_label_id_updated_at: null, global_created_at: "2026-02-10T00:00:00.000Z",
        global_updated_at: "2026-02-10T00:00:00.000Z", data: {}, deleted_at: null,
      }],
    };
    const slotUpsertResponse = {
      success: true, message: null,
      data: [{ id: "slot-1", deleted_at: "2026-02-10T12:00:00.000Z" }],
    };
    fetchSpy.mockImplementation(chainableFetch([
      getTaskResponse, patchResponse, slotFetch, slotUpsertResponse,
    ]));
    const consoleLogSpy = spyOn(console, "log");

    // when
    await taskUnscheduleCommand.run({
      args: { id: "task-uuid-1", deleteSlot: true, _: [] },
      rawArgs: [],
    } as any);

    // then
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Soft-deleted empty slot slot-1"));

    consoleLogSpy.mockRestore();
  });
});
