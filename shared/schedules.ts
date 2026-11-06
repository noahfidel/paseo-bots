import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { CALENDAR_FIELDS, describeCron, describeEntries, describeInterval, fromCalendarEntries, parseCron, type CalendarEntry } from "./launchd-cron";

// The Schedules screen: one list of everything that runs on a timer on this
// host — bot routines, launchd jobs (this plugin's own LaunchAgents) and
// Paseo's own schedules — and the contracts behind it. Everything here is pure
// so both bundles and the tests can use it.

export const SCHEDULE_KINDS = ["routine", "launchd", "paseo"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const KIND_LABELS: Record<ScheduleKind, string> = {
  routine: "Bot routine",
  launchd: "launchd",
  paseo: "Paseo schedule",
};

// ---------------------------------------------------------------- launchd job specs

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");

/** What the editor asks for: every N minutes, or at set times every day or on some weekdays. */
export const LaunchdScheduleSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(1).max(10_080) }),
  z.object({
    type: z.literal("calendar"),
    times: z.array(TimeOfDay).min(1).max(24),
    /** 0 = Sunday. Empty means every day. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  }),
]);
export type LaunchdScheduleSpec = z.infer<typeof LaunchdScheduleSpecSchema>;

export const LaunchdJobSpecSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Run through `/bin/zsh -lc`. */
  command: z.string().trim().min(1),
  schedule: LaunchdScheduleSpecSchema,
  /** The job's PATH; null takes the login shell's PATH when saving. */
  path: z.string().trim().min(1).nullable(),
  /** Absolute working directory; null for launchd's default. Left out on edit to keep the current one. */
  cwd: z.string().trim().nullable().optional(),
});
export type LaunchdJobSpec = z.infer<typeof LaunchdJobSpecSchema>;

/** What a plist on disk says about when it fires. `custom` is any calendar the editor can't show. */
export const LaunchdScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), seconds: z.number().int(), description: z.string() }),
  z.object({ type: z.literal("calendar"), times: z.array(z.string()), weekdays: z.array(z.number().int()), description: z.string() }),
  z.object({ type: z.literal("custom"), description: z.string() }),
  z.object({ type: z.literal("none"), description: z.string() }),
]);
export type LaunchdSchedule = z.infer<typeof LaunchdScheduleSchema>;

/** One line of the runner's history file. */
export const RunRecordSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().min(0),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const pad = (value: number) => String(value).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sortedTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort();
}

/** launchd calendar entries for a calendar spec: one per time and weekday. */
export function calendarEntriesFor(times: readonly string[], weekdays: readonly number[]): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const time of sortedTimes(times)) {
    const [hour, minute] = time.split(":").map(Number) as [number, number];
    const days = sortedUnique(weekdays);
    if (days.length === 0 || days.length === 7) entries.push({ hour, minute });
    else for (const weekday of days) entries.push({ hour, minute, weekday });
  }
  return entries;
}

/** "Every day at 09:00", "Mon–Fri at 09:00 and 17:30", "Sun at 08:15". */
export function describeCalendar(times: readonly string[], weekdays: readonly number[]): string {
  const days = sortedUnique(weekdays);
  const list = sortedTimes(times);
  const at = list.length <= 1 ? list[0] ?? "" : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  let which: string;
  if (days.length === 0 || days.length === 7) which = "Every day";
  else if (days.join(",") === "1,2,3,4,5") which = "Mon–Fri";
  else if (days.join(",") === "0,6") which = "Weekends";
  else which = days.map((day) => WEEKDAYS[day]).join(", ");
  return `${which} at ${at}`;
}

export function describeLaunchdSpec(schedule: LaunchdScheduleSpec): string {
  return schedule.type === "interval" ? describeInterval(schedule.minutes * 60) : describeCalendar(schedule.times, schedule.weekdays);
}

/**
 * Reads launchd's calendar entries back into the editor's shape when they are
 * one: hour and minute in every entry, no day or month, and the entries are
 * exactly times × weekdays. Anything else is `custom` (still described).
 */
export function calendarScheduleFromEntries(entries: readonly CalendarEntry[]): LaunchdSchedule {
  if (entries.length === 0) return { type: "none", description: "Only when run by hand" };
  const simple = entries.every((entry) => entry.hour !== undefined && entry.minute !== undefined && entry.day === undefined && entry.month === undefined);
  if (simple) {
    const times = sortedTimes(entries.map((entry) => `${pad(entry.hour!)}:${pad(entry.minute!)}`));
    const withDay = entries.filter((entry) => entry.weekday !== undefined);
    if (withDay.length === 0 || withDay.length === entries.length) {
      const weekdays = sortedUnique(withDay.map((entry) => entry.weekday! % 7));
      const expected = calendarEntriesFor(times, weekdays).length;
      const product = withDay.length === 0 ? times.length : times.length * weekdays.length;
      if (expected === entries.length && product === entries.length) {
        return { type: "calendar", times, weekdays, description: describeCalendar(times, weekdays) };
      }
    }
  }
  const fields = fromCalendarEntries(entries);
  return { type: "custom", description: fields ? describeCron(fields) : describeEntries(entries) };
}

/** The editor's spec for a schedule read from disk, or null when it can't edit it as is. */
export function specFromSchedule(schedule: LaunchdSchedule): LaunchdScheduleSpec | null {
  if (schedule.type === "interval") return schedule.seconds % 60 === 0 ? { type: "interval", minutes: Math.max(1, schedule.seconds / 60) } : null;
  if (schedule.type === "calendar") return { type: "calendar", times: schedule.times, weekdays: schedule.weekdays };
  return null;
}

function entryMatchesDay(entry: CalendarEntry, day: Date): boolean {
  if (entry.month !== undefined && entry.month !== day.getMonth() + 1) return false;
  if (entry.day !== undefined && entry.day !== day.getDate()) return false;
  if (entry.weekday !== undefined && entry.weekday % 7 !== day.getDay()) return false;
  return true;
}

/** The next local time any of the entries fires after `now`, looking up to a year ahead. */
export function nextCalendarFire(entries: readonly CalendarEntry[], now: Date): Date | null {
  if (entries.length === 0) return null;
  for (let ahead = 0; ahead <= 366; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    let best: Date | null = null;
    for (const entry of entries) {
      if (!entryMatchesDay(entry, day)) continue;
      const hours = entry.hour === undefined ? [...Array(24).keys()] : [entry.hour];
      const minutes = entry.minute === undefined ? [...Array(60).keys()] : [entry.minute];
      for (const hour of hours) {
        const minute = minutes.find((value) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, value) > now);
        if (minute === undefined) continue;
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (!best || at < best) best = at;
        break;
      }
    }
    if (best) return best;
  }
  return null;
}

/** "09:00, 17:30" → ["09:00", "17:30"]; "9:5" is refused. */
export function parseTimes(text: string): { ok: true; times: string[] } | { ok: false; error: string } {
  const parts = text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "Add at least one time, like 09:00" };
  const times: string[] = [];
  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(part);
    const hour = match ? Number(match[1]) : NaN;
    const minute = match ? Number(match[2]) : NaN;
    if (!match || hour > 23 || minute > 59) return { ok: false, error: `"${part}" isn't a time; use HH:MM, 24-hour` };
    times.push(`${pad(hour)}:${pad(minute)}`);
  }
  return { ok: true, times: sortedTimes(times) };
}

/** Plain words for a Paseo schedule's cadence. */
export function describePaseoCadence(cadence: { type: "every"; everyMs: number } | { type: "cron"; expression: string; timezone?: string }): string {
  if (cadence.type === "every") return describeInterval(Math.max(1, Math.round(cadence.everyMs / 1000)));
  const parsed = parseCron(cadence.expression);
  const text = parsed.ok ? describeCron(parsed.fields) : cadence.expression;
  return `${text} (${cadence.timezone ?? "UTC"})`;
}

export { CALENDAR_FIELDS };

// ---------------------------------------------------------------- the list

export const LastRunSchema = z.object({
  /** Tells runs apart; the failure alert remembers it. */
  id: z.string(),
  status: z.enum(["succeeded", "failed", "running", "skipped"]),
  at: z.string(),
  error: z.string().nullable(),
  /** The chat the run used, when there is one. */
  agentId: z.string().nullable(),
});
export type LastRun = z.infer<typeof LastRunSchema>;

export const ScheduleItemSchema = z.object({
  /** `<kind>:<id>`, unique across the list. */
  key: z.string(),
  kind: z.enum(SCHEDULE_KINDS),
  id: z.string(),
  name: z.string(),
  /** When it runs, in plain words. */
  schedule: z.string(),
  nextRunAt: z.string().nullable(),
  paused: z.boolean(),
  running: z.boolean(),
  lastRun: LastRunSchema.nullable(),
  /** Why the last run failed, or why the item can't run. */
  failure: z.string().nullable(),
  routine: z.object({ botId: z.string(), botName: z.string(), routineId: z.string() }).optional(),
  launchd: z
    .object({
      label: z.string(),
      command: z.string(),
      cwd: z.string().nullable(),
      path: z.string().nullable(),
      schedule: LaunchdScheduleSchema,
      loaded: z.boolean(),
      managed: z.boolean(),
      problem: z.string().nullable(),
    })
    .optional(),
  paseo: z.object({ status: z.enum(["active", "paused", "completed"]), prompt: z.string() }).optional(),
});
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

export const schedulesListRpc = defineRpc({
  name: "bots.schedules.list",
  input: z.object({}),
  output: z.object({
    items: z.array(ScheduleItemSchema),
    launchd: z.object({ supported: z.boolean(), shown: z.boolean(), error: z.string().nullable() }),
    /** Why Paseo's schedules couldn't be listed, if they couldn't. */
    paseo: z.object({ error: z.string().nullable() }),
  }),
});

export const AlertSchema = z.object({ key: z.string(), kind: z.enum(SCHEDULE_KINDS), name: z.string(), failure: z.string() });
export type Alert = z.infer<typeof AlertSchema>;

/** Failures not alerted yet. Each is returned once: the call records it as seen. */
export const schedulesAlertsRpc = defineRpc({
  name: "bots.schedules.alerts",
  input: z.object({}),
  output: z.object({ alerts: z.array(AlertSchema) }),
});

const JobId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const JobResult = z.object({ id: z.string() });

export const launchdCreateRpc = defineRpc({ name: "bots.schedules.launchd.create", input: LaunchdJobSpecSchema, output: JobResult });
export const launchdUpdateRpc = defineRpc({ name: "bots.schedules.launchd.update", input: z.object({ id: JobId, spec: LaunchdJobSpecSchema }), output: JobResult });
export const launchdDeleteRpc = defineRpc({ name: "bots.schedules.launchd.delete", input: z.object({ id: JobId }), output: z.object({}) });
export const launchdRunRpc = defineRpc({ name: "bots.schedules.launchd.run", input: z.object({ id: JobId }), output: z.object({}) });
export const launchdSetEnabledRpc = defineRpc({
  name: "bots.schedules.launchd.set-enabled",
  input: z.object({ id: JobId, enabled: z.boolean() }),
  output: z.object({}),
});
export const launchdLogRpc = defineRpc({
  name: "bots.schedules.launchd.log",
  input: z.object({ id: JobId }),
  output: z.object({ text: z.string(), truncated: z.boolean(), path: z.string(), runs: z.array(RunRecordSchema) }),
});

const PaseoScheduleId = z.object({ id: z.string().min(1).max(200) });
export const paseoPauseRpc = defineRpc({ name: "bots.schedules.paseo.pause", input: PaseoScheduleId, output: z.object({}) });
export const paseoResumeRpc = defineRpc({ name: "bots.schedules.paseo.resume", input: PaseoScheduleId, output: z.object({}) });
export const paseoRunOnceRpc = defineRpc({ name: "bots.schedules.paseo.run-once", input: PaseoScheduleId, output: z.object({}) });

export const PaseoRunSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  agentId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type PaseoRun = z.infer<typeof PaseoRunSchema>;
export const paseoLogsRpc = defineRpc({ name: "bots.schedules.paseo.logs", input: PaseoScheduleId, output: z.object({ runs: z.array(PaseoRunSchema) }) });

export const SCHEDULE_RPCS = [
  schedulesListRpc,
  schedulesAlertsRpc,
  launchdCreateRpc,
  launchdUpdateRpc,
  launchdDeleteRpc,
  launchdRunRpc,
  launchdSetEnabledRpc,
  launchdLogRpc,
  paseoPauseRpc,
  paseoResumeRpc,
  paseoRunOnceRpc,
  paseoLogsRpc,
] as const;

// ---------------------------------------------------------------- failure alerts

/** A failing item: its key and the run that failed. */
export interface Failure {
  key: string;
  kind: ScheduleKind;
  name: string;
  runId: string;
  failure: string;
}

/** The items whose last run failed, with that run. */
export function failuresOf(items: readonly ScheduleItem[]): Failure[] {
  return items.flatMap((item) =>
    item.lastRun?.status === "failed" ? [{ key: item.key, kind: item.kind, name: item.name, runId: item.lastRun.id, failure: item.failure ?? item.lastRun.error ?? "Failed" }] : [],
  );
}

/**
 * Which failures to alert about, and what to remember. What's remembered is
 * the failing run per item, so a later failure of the same item alerts again
 * and an alerted one never does. With nothing remembered yet (first start)
 * the current failures are taken as already seen: only new ones alert.
 * Items that aren't failing any more are forgotten.
 */
export function takeNewFailures(failures: readonly Failure[], seen: Readonly<Record<string, string>> | null): { alerts: Failure[]; seen: Record<string, string> } {
  const next: Record<string, string> = {};
  for (const failure of failures) next[failure.key] = failure.runId;
  if (seen === null) return { alerts: [], seen: next };
  return { alerts: failures.filter((failure) => seen[failure.key] !== failure.runId), seen: next };
}

/** "3 min ago", "in 2 h", for the rows. */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const diff = at - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? null : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  if (!unit) return diff >= 0 ? "in under a minute" : "just now";
  return diff >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}
