import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type BotSettingsValues } from "../shared/bot";
import type { LaunchdJobs } from "../server/launchd";
import type { PaseoSchedulesClient } from "../server/paseo-schedules";
import { routineItems, Schedules } from "../server/schedules";
import { makeBot, NOW } from "./helpers";
import * as schedules from "../shared/schedules";
import {
  calendarEntriesFor,
  calendarScheduleFromEntries,
  describePaseoCadence,
  failuresOf,
  nextCalendarFire,
  parseTimes,
  SCHEDULE_RPCS,
  specFromSchedule,
  takeNewFailures,
  type Failure,
  type ScheduleItem,
} from "../shared/schedules";

const RPC_NAME = /^[a-z][a-z0-9._-]*$/;

describe("schedule RPC contracts", () => {
  it("every defineRpc export is listed, named bots.schedules.*, and installable", () => {
    const exported = (Object.values(schedules) as unknown[]).filter(
      (value): value is { name: string } => typeof value === "object" && value !== null && "name" in value && "input" in value && "output" in value,
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(new Set(exported)).toEqual(new Set(SCHEDULE_RPCS));
    for (const contract of exported) {
      expect(contract.name).toMatch(RPC_NAME);
      expect(contract.name.startsWith("bots.schedules.")).toBe(true);
    }
    expect(new Set(exported.map((contract) => contract.name)).size).toBe(exported.length);
  });
});

describe("takeNewFailures", () => {
  const failure = (key: string, runId: string): Failure => ({ key, kind: "launchd", name: key, runId, failure: "Exited with code 1" });

  it("takes the failures present on first start as seen, without alerting", () => {
    const result = takeNewFailures([failure("launchd:a", "r1")], null);
    expect(result.alerts).toEqual([]);
    expect(result.seen).toEqual({ "launchd:a": "r1" });
  });

  it("alerts a new failure once, then not again", () => {
    const first = takeNewFailures([failure("launchd:a", "r1")], {});
    expect(first.alerts.map((entry) => entry.key)).toEqual(["launchd:a"]);
    const second = takeNewFailures([failure("launchd:a", "r1")], first.seen);
    expect(second.alerts).toEqual([]);
  });

  it("alerts again when the same item fails on a later run", () => {
    const seen = { "launchd:a": "r1" };
    expect(takeNewFailures([failure("launchd:a", "r2")], seen).alerts.map((entry) => entry.runId)).toEqual(["r2"]);
  });

  it("forgets items that recovered, so their next failure alerts", () => {
    const recovered = takeNewFailures([], { "launchd:a": "r1" });
    expect(recovered.seen).toEqual({});
    expect(takeNewFailures([failure("launchd:a", "r1")], recovered.seen).alerts).toHaveLength(1);
  });
});

describe("failuresOf", () => {
  it("lists only items whose last run failed, with the reason", () => {
    const item = (key: string, status: "failed" | "succeeded", failure: string | null): ScheduleItem => ({
      key,
      kind: "paseo",
      id: key,
      name: key,
      schedule: "",
      nextRunAt: null,
      paused: false,
      running: false,
      lastRun: { id: `${key}-run`, status, at: "2026-11-06T00:00:00Z", error: failure, agentId: null },
      failure,
    });
    expect(failuresOf([item("a", "failed", "boom"), item("b", "succeeded", null)])).toEqual([{ key: "a", kind: "paseo", name: "a", runId: "a-run", failure: "boom" }]);
  });
});

describe("launchd calendar schedules", () => {
  it("round-trips a daily schedule", () => {
    const entries = calendarEntriesFor(["17:30", "09:00"], []);
    expect(entries).toEqual([
      { hour: 9, minute: 0 },
      { hour: 17, minute: 30 },
    ]);
    expect(calendarScheduleFromEntries(entries)).toEqual({ type: "calendar", times: ["09:00", "17:30"], weekdays: [], description: "Every day at 09:00 and 17:30" });
  });

  it("round-trips a weekly schedule", () => {
    const entries = calendarEntriesFor(["08:15"], [5, 1]);
    expect(entries).toEqual([
      { hour: 8, minute: 15, weekday: 1 },
      { hour: 8, minute: 15, weekday: 5 },
    ]);
    const schedule = calendarScheduleFromEntries(entries);
    expect(schedule).toEqual({ type: "calendar", times: ["08:15"], weekdays: [1, 5], description: "Mon, Fri at 08:15" });
    expect(specFromSchedule(schedule)).toEqual({ type: "calendar", times: ["08:15"], weekdays: [1, 5] });
  });

  it("treats all seven weekdays as every day", () => {
    expect(calendarEntriesFor(["09:00"], [0, 1, 2, 3, 4, 5, 6])).toEqual([{ hour: 9, minute: 0 }]);
  });

  it("calls anything else custom, still in words", () => {
    const schedule = calendarScheduleFromEntries([{ minute: 0, hour: 9, day: 1 }]);
    expect(schedule.type).toBe("custom");
    expect(schedule.description).toBe("At 09:00 on day 1");
    expect(specFromSchedule(schedule)).toBeNull();
    expect(calendarScheduleFromEntries([{ minute: 30 }]).type).toBe("custom");
  });

  it("finds the next fire time", () => {
    const now = new Date(2026, 10, 6, 10, 0); // Friday 10:00 local
    expect(nextCalendarFire(calendarEntriesFor(["09:00", "17:30"], []), now)).toEqual(new Date(2026, 10, 6, 17, 30));
    expect(nextCalendarFire(calendarEntriesFor(["09:00"], [1]), now)).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(nextCalendarFire([{ minute: 30 }], now)).toEqual(new Date(2026, 10, 6, 10, 30));
    expect(nextCalendarFire([], now)).toBeNull();
  });
});

describe("parseTimes", () => {
  it("normalises and sorts", () => {
    expect(parseTimes("17:30, 9:00")).toEqual({ ok: true, times: ["09:00", "17:30"] });
  });
  it("refuses bad times", () => {
    expect(parseTimes("25:00").ok).toBe(false);
    expect(parseTimes("").ok).toBe(false);
  });
});

describe("describePaseoCadence", () => {
  it("reads every and cron cadences", () => {
    expect(describePaseoCadence({ type: "every", everyMs: 300_000 })).toBe("Every 5 minutes");
    expect(describePaseoCadence({ type: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Prague" })).toBe("At 09:00 on Mon–Fri (Europe/Prague)");
    expect(describePaseoCadence({ type: "cron", expression: "0 9 * * *" })).toBe("At 09:00 (UTC)");
  });
});

describe("webhook routines on the All schedules screen", () => {
  const bot = makeBot({
    id: "bot-1",
    name: "Docs",
    routines: [
      { id: "r-timed", name: "Nightly", prompt: "p", enabled: true, schedule: { kind: "interval", minutes: 60 }, resultsChatId: null, createdAt: NOW },
      { id: "r-hook", name: "Doc handoff", prompt: "p", enabled: true, schedule: { kind: "webhook" }, resultsChatId: null, createdAt: NOW },
    ],
  });
  const values: BotSettingsValues = { bots: [bot], history: [], library: EMPTY_LIBRARY };
  const failedRun = (id: string) => ({ id, trigger: "webhook" as const, scheduledFor: NOW, startedAt: NOW, endedAt: NOW, status: "failed" as const, agentId: null, output: null, error: "boom" });
  const records = { "r-hook": { lastRunAt: NOW, runs: [failedRun("run-1")] } };
  const now = new Date(NOW);

  it("routineItems can leave webhook routines out, and keeps them otherwise", () => {
    expect(routineItems(values, records, now, { timedOnly: true }).map((item) => item.id)).toEqual(["r-timed"]);
    expect(routineItems(values, records, now).map((item) => item.id)).toEqual(["r-timed", "r-hook"]);
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "schedules-"));
    const schedules = new Schedules({
      values: async () => values,
      routineRecords: async () => records,
      launchd: { supported: false } as unknown as LaunchdJobs,
      paseo: { list: async () => [] } as unknown as PaseoSchedulesClient,
      seenPath: join(dir, "seen.json"),
      now: () => now,
    });
    return schedules;
  }

  it("list() shows the timed routine but not the webhook one", async () => {
    const { items } = await (await setup()).list();
    expect(items.map((item) => item.id)).toEqual(["r-timed"]);
  });

  it("still alerts when a webhook routine's run fails", async () => {
    const schedules = await setup();
    await schedules.alerts(); // first call records what already failed
    (records["r-hook"] as { runs: unknown[] }).runs = [failedRun("run-2")];
    const { alerts } = await schedules.alerts();
    expect(alerts.map((alert) => alert.key)).toEqual(["routine:r-hook"]);
  });
});
