import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchdJobs } from "../server/launchd";
import { PaseoCliSchedules, paseoItem, paseoRuns, type PaseoSchedule, type PaseoSchedulesClient } from "../server/paseo-schedules";
import { launchdItem, routineItems, Schedules } from "../server/schedules";
import type { BotSettingsValues } from "../shared/bot";
import type { RoutineRecord } from "../shared/rpc";
import { makeBot } from "./helpers";

function schedule(patch: Partial<PaseoSchedule> = {}): PaseoSchedule {
  return {
    id: "sch-1",
    name: "Morning digest",
    prompt: "Summarise my inbox",
    cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Prague" },
    status: "active",
    nextRunAt: "2026-11-09T08:00:00.000Z",
    lastRunAt: "2026-11-06T08:00:00.000Z",
    runs: [
      { id: "run-1", startedAt: "2026-11-05T08:00:00.000Z", endedAt: "2026-11-05T08:01:00.000Z", status: "succeeded", agentId: "a1", output: "ok", error: null },
      { id: "run-2", startedAt: "2026-11-06T08:00:00.000Z", endedAt: "2026-11-06T08:00:30.000Z", status: "failed", agentId: "a2", output: null, error: "Provider error" },
    ],
    ...patch,
  };
}

describe("Paseo schedule mapping", () => {
  it("maps an active schedule with a failed last run", () => {
    expect(paseoItem(schedule())).toEqual({
      key: "paseo:sch-1",
      kind: "paseo",
      id: "sch-1",
      name: "Morning digest",
      schedule: "At 09:00 on Mon–Fri (Europe/Prague)",
      nextRunAt: "2026-11-09T08:00:00.000Z",
      paused: false,
      running: false,
      lastRun: { id: "run-2", status: "failed", at: "2026-11-06T08:00:30.000Z", error: "Provider error", agentId: "a2" },
      failure: "Provider error",
      paseo: { status: "active", prompt: "Summarise my inbox" },
    });
  });

  it("maps paused and completed schedules without a next run, and names unnamed ones by prompt", () => {
    const paused = paseoItem(schedule({ status: "paused", name: null, runs: [] }));
    expect(paused).toMatchObject({ paused: true, nextRunAt: null, name: "Summarise my inbox", lastRun: null, failure: null });
    expect(paseoItem(schedule({ status: "completed" })).schedule).toBe("At 09:00 on Mon–Fri (Europe/Prague) · completed");
  });

  it("lists runs newest first", () => {
    expect(paseoRuns(schedule()).map((run) => run.id)).toEqual(["run-2", "run-1"]);
  });
});

describe("PaseoCliSchedules", () => {
  it("lists with ls then inspects each, and sends actions as CLI calls", async () => {
    const calls: string[][] = [];
    const cli = new PaseoCliSchedules(async (args) => {
      calls.push(args);
      if (args[0] === "ls") return JSON.stringify([{ id: "sch-1", name: "Morning digest", cadence: "cron:0 9 * * 1-5", status: "active" }]);
      if (args[0] === "inspect") return JSON.stringify(schedule({ id: args[1]! }));
      return JSON.stringify({ id: args[1], status: args[0] === "pause" ? "paused" : "active" });
    });
    const list = await cli.list();
    expect(list.map((entry) => entry.id)).toEqual(["sch-1"]);
    await cli.pause("sch-1");
    await cli.resume("sch-1");
    await cli.runOnce("sch-1");
    expect(calls).toEqual([["ls"], ["inspect", "sch-1"], ["pause", "sch-1"], ["resume", "sch-1"], ["run-once", "sch-1"]]);
  });

  it("reports a CLI that doesn't return JSON", async () => {
    const cli = new PaseoCliSchedules(async () => "Cannot connect to daemon");
    await expect(cli.list()).rejects.toThrow("didn't return JSON");
  });
});

describe("routine and launchd rows", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");

  it("maps a routine with its last run, next run and pause", () => {
    const bot = makeBot({ routines: [{ id: "rt-1", name: "Digest", prompt: "p", enabled: true, schedule: { kind: "interval", minutes: 60 }, resultsChatId: null, createdAt: "2026-11-01T00:00:00.000Z" }] });
    const records: Record<string, RoutineRecord> = {
      "rt-1": { lastRunAt: "2026-11-06T11:30:00.000Z", runs: [{ id: "run-a", trigger: "schedule", scheduledFor: "x", startedAt: "2026-11-06T11:30:00.000Z", endedAt: "2026-11-06T11:31:00.000Z", status: "failed", agentId: "agent-9", output: null, error: "Finished without a reply." }] },
    };
    const values = { bots: [bot], history: [] } as unknown as BotSettingsValues;
    const [item] = routineItems(values, records, now);
    expect(item).toMatchObject({
      key: "routine:rt-1",
      kind: "routine",
      name: "Inbox: Digest",
      schedule: "Every 1h",
      nextRunAt: "2026-11-06T12:30:00.000Z",
      paused: false,
      lastRun: { id: "run-a", status: "failed", agentId: "agent-9" },
      failure: "Finished without a reply.",
      routine: { botId: bot.id, routineId: "rt-1" },
    });
    const pausedValues = { bots: [{ ...bot, routines: [{ ...bot.routines[0]!, enabled: false }] }], history: [] } as unknown as BotSettingsValues;
    expect(routineItems(pausedValues, records, now)[0]).toMatchObject({ paused: true, nextRunAt: null });
  });

  it("maps a launchd job's exit code to a failure", () => {
    const item = launchdItem(
      {
        id: "job",
        label: "com.noahfidel.schedules.job",
        name: "Job",
        command: "false",
        cwd: null,
        path: "/bin",
        schedule: { type: "interval", seconds: 3600, description: "Every hour" },
        entries: [],
        managed: true,
        loaded: true,
        disabled: false,
        running: false,
        lastExitCode: 1,
        recentRuns: [{ startedAt: "2026-11-06T11:30:00Z", finishedAt: "2026-11-06T11:30:01Z", exitCode: 1, durationMs: 1000 }],
        plistPath: "",
        logPath: "",
        problem: null,
      },
      now,
    );
    expect(item).toMatchObject({ failure: "Exited with code 1", nextRunAt: "2026-11-06T12:30:00.000Z", lastRun: { status: "failed", id: "2026-11-06T11:30:00Z" } });
  });
});

describe("Schedules alerts", () => {
  let root: string;
  let paseoSchedules: PaseoSchedule[];
  let launchdRuns: { id: string; name: string; run: { startedAt: string; finishedAt: string; exitCode: number; durationMs: number } | null }[];
  let paseoDown: boolean;
  let values: BotSettingsValues;
  let schedules: Schedules;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "schedules-alerts-"));
    paseoSchedules = [schedule({ runs: [] })];
    launchdRuns = [];
    paseoDown = false;
    values = { bots: [], history: [] } as unknown as BotSettingsValues;
    const paseo: PaseoSchedulesClient = {
      list: async () => {
        if (paseoDown) throw new Error("daemon down");
        return paseoSchedules;
      },
      inspect: async () => paseoSchedules[0]!,
      pause: async () => {},
      resume: async () => {},
      runOnce: async () => {},
    };
    const launchd = { supported: true, latestRuns: async () => launchdRuns, list: async () => [] } as unknown as LaunchdJobs;
    schedules = new Schedules({ values: async () => values, routineRecords: async () => ({}), launchd, paseo, seenPath: join(root, "seen.json") });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const failRun = (startedAt: string) => ({ startedAt, finishedAt: startedAt, exitCode: 2, durationMs: 1 });

  it("stays quiet on first start, then alerts each new failure once", async () => {
    launchdRuns = [{ id: "old", name: "Old", run: failRun("t0") }];
    expect((await schedules.alerts()).alerts).toEqual([]);

    paseoSchedules = [schedule()];
    launchdRuns = [{ id: "old", name: "Old", run: failRun("t0") }, { id: "job", name: "Job", run: failRun("t1") }];
    const { alerts } = await schedules.alerts();
    expect(alerts.map((alert) => alert.key).sort()).toEqual(["launchd:job", "paseo:sch-1"]);
    expect(alerts.find((alert) => alert.key === "launchd:job")).toEqual({ key: "launchd:job", kind: "launchd", name: "Job", failure: "Exited with code 2" });
    expect((await schedules.alerts()).alerts).toEqual([]);

    launchdRuns = [{ id: "job", name: "Job", run: failRun("t2") }];
    expect((await schedules.alerts()).alerts.map((alert) => alert.key)).toEqual(["launchd:job"]);
  });

  it("doesn't re-alert a source's failures after it was briefly unreadable", async () => {
    await schedules.alerts();
    paseoSchedules = [schedule()];
    expect((await schedules.alerts()).alerts).toHaveLength(1);
    paseoDown = true;
    expect((await schedules.alerts()).alerts).toEqual([]);
    paseoDown = false;
    expect((await schedules.alerts()).alerts).toEqual([]);
  });

  it("leaves launchd out when the setting hides it", async () => {
    await schedules.alerts();
    values = { bots: [], history: [], showLaunchdJobs: false } as unknown as BotSettingsValues;
    launchdRuns = [{ id: "job", name: "Job", run: failRun("t1") }];
    expect((await schedules.alerts()).alerts).toEqual([]);
    const listed = await schedules.list();
    expect(listed.launchd).toEqual({ supported: true, shown: false, error: null });
  });
});
