// The Schedules screen's daemon side: one list from bot routines, launchd jobs
// and Paseo's schedules, and the failure alerts drawn from it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotSettingsValues } from "../shared/bot";
import type { RoutineRecord } from "../shared/rpc";
import { describeSchedule, nextRun } from "../shared/routines";
import { failuresOf, nextCalendarFire, takeNewFailures, type Alert, type Failure, type LastRun, type ScheduleItem, type ScheduleKind } from "../shared/schedules";
import type { LaunchdJob, LaunchdJobs } from "./launchd";
import { paseoItem, type PaseoSchedulesClient } from "./paseo-schedules";

export interface SchedulesDeps {
  values(): Promise<BotSettingsValues | null>;
  routineRecords(): Promise<Record<string, RoutineRecord>>;
  launchd: LaunchdJobs;
  paseo: PaseoSchedulesClient;
  /** Where the alerted failures are remembered. */
  seenPath: string;
  now?: () => Date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every routine of every local bot; `timedOnly` leaves out the ones that only run when their webhook is called (they're alerted on, not listed). */
export function routineItems(values: BotSettingsValues | null, records: Record<string, RoutineRecord>, now: Date, options: { timedOnly?: boolean } = {}): ScheduleItem[] {
  if (!values) return [];
  return values.bots
    .filter((bot) => !bot.archived && !bot.hostId)
    .flatMap((bot) =>
      bot.routines.filter((routine) => !options.timedOnly || routine.schedule.kind !== "webhook").map((routine): ScheduleItem => {
        const record = records[routine.id];
        const run = record?.runs.at(-1) ?? null;
        const status: LastRun["status"] | null = run ? (run.status === "skipped-busy" || run.status === "skipped-missed" ? "skipped" : run.status) : null;
        const lastRun: LastRun | null = run && status ? { id: run.id, status, at: run.endedAt ?? run.startedAt, error: run.error, agentId: run.agentId } : null;
        const next = routine.enabled ? nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now) : null;
        return {
          key: `routine:${routine.id}`,
          kind: "routine",
          id: routine.id,
          name: `${bot.name}: ${routine.name}`,
          schedule: describeSchedule(routine.schedule),
          nextRunAt: next ? next.toISOString() : null,
          paused: !routine.enabled,
          running: status === "running",
          lastRun,
          failure: status === "failed" ? (run?.error?.trim() || "The run failed.") : null,
          routine: { botId: bot.id, botName: bot.name, routineId: routine.id },
        };
      }),
    );
}

export function launchdItem(job: LaunchdJob, now: Date): ScheduleItem {
  const run = job.recentRuns[0] ?? null;
  const failed = run !== null && run.exitCode !== 0;
  let next: Date | null = null;
  if (job.loaded && !job.disabled) {
    if (job.schedule.type === "interval") {
      const after = run ? Date.parse(run.startedAt) + job.schedule.seconds * 1000 : NaN;
      next = after > now.getTime() ? new Date(after) : null;
    } else next = nextCalendarFire(job.entries, now);
  }
  const notLoaded = !job.loaded && !job.disabled ? "launchd hasn't loaded this job. Resume it to load it again." : null;
  return {
    key: `launchd:${job.id}`,
    kind: "launchd",
    id: job.id,
    name: job.name,
    schedule: job.schedule.description,
    nextRunAt: next ? next.toISOString() : null,
    paused: job.disabled,
    running: job.running,
    lastRun: run ? { id: run.startedAt, status: failed ? "failed" : "succeeded", at: run.finishedAt, error: failed ? `Exited with code ${run.exitCode}` : null, agentId: null } : null,
    failure: job.problem ?? (failed ? `Exited with code ${run.exitCode}` : notLoaded),
    launchd: { label: job.label, command: job.command, cwd: job.cwd, path: job.path, schedule: job.schedule, loaded: job.loaded, managed: job.managed, problem: job.problem },
  };
}

const ORDER: Record<ScheduleKind, number> = { routine: 0, launchd: 1, paseo: 2 };

export class Schedules {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SchedulesDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async showLaunchd(values: BotSettingsValues | null): Promise<boolean> {
    return this.deps.launchd.supported && values?.showLaunchdJobs !== false;
  }

  async list() {
    const now = this.now();
    const values = await this.deps.values();
    const shown = await this.showLaunchd(values);
    const [records, launchd, paseo] = await Promise.all([
      this.deps.routineRecords().catch(() => ({})),
      shown ? this.deps.launchd.list().then((jobs) => ({ jobs, error: null }), (error: unknown) => ({ jobs: [] as LaunchdJob[], error: message(error) })) : { jobs: [] as LaunchdJob[], error: null },
      this.deps.paseo.list().then((schedules) => ({ schedules, error: null }), (error: unknown) => ({ schedules: [], error: message(error) })),
    ]);
    const items = [...routineItems(values, records, now, { timedOnly: true }), ...launchd.jobs.map((job) => launchdItem(job, now)), ...paseo.schedules.map(paseoItem)];
    items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));
    return { items, launchd: { supported: this.deps.launchd.supported, shown, error: launchd.error }, paseo: { error: paseo.error } };
  }

  /** The failures of every source that could be read, cheaply (no launchctl). Unread sources are named. */
  private async failures(): Promise<{ failures: Failure[]; unread: Set<ScheduleKind> }> {
    const now = this.now();
    const values = await this.deps.values();
    const unread = new Set<ScheduleKind>();
    const failures: Failure[] = [];
    if (values) {
      const records = await this.deps.routineRecords().catch(() => null);
      if (records) failures.push(...failuresOf(routineItems(values, records, now)));
      else unread.add("routine");
    } else unread.add("routine");
    if (await this.showLaunchd(values)) {
      try {
        for (const { id, name, run } of await this.deps.launchd.latestRuns()) {
          if (run && run.exitCode !== 0) failures.push({ key: `launchd:${id}`, kind: "launchd", name, runId: run.startedAt, failure: `Exited with code ${run.exitCode}` });
        }
      } catch {
        unread.add("launchd");
      }
    }
    try {
      failures.push(...failuresOf((await this.deps.paseo.list()).map(paseoItem)));
    } catch {
      unread.add("paseo");
    }
    return { failures, unread };
  }

  private async readSeen(): Promise<Record<string, string> | null> {
    try {
      return JSON.parse(await readFile(this.deps.seenPath, "utf8")) as Record<string, string>;
    } catch {
      return null;
    }
  }

  /** New failures since the last call, each returned once. A source that couldn't be read keeps what was remembered. */
  alerts(): Promise<{ alerts: Alert[] }> {
    const run = async () => {
      const [{ failures, unread }, seen] = await Promise.all([this.failures(), this.readSeen()]);
      const result = takeNewFailures(failures, seen);
      const kindOf = (key: string) => key.slice(0, key.indexOf(":")) as ScheduleKind;
      for (const [key, runId] of Object.entries(seen ?? {})) if (unread.has(kindOf(key))) result.seen[key] = runId;
      await mkdir(dirname(this.deps.seenPath), { recursive: true });
      await writeFile(this.deps.seenPath, `${JSON.stringify(result.seen, null, 2)}\n`, "utf8");
      return { alerts: result.alerts.map(({ key, kind, name, failure }) => ({ key, kind, name, failure })) };
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }
}
