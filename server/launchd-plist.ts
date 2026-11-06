// launchd plists for the Schedules screen: rendering one, and reading its
// schedule and command back. Ported from @gpambrozio/paseo-launchd-jobs 0.6.0
// (server/jobs.ts, MIT License, Copyright (c) 2026 Gustavo Ambrozio), with a
// generic plist writer so an adopted job's own keys carry over untouched.

import type { CalendarEntry } from "../shared/launchd-cron";
import { describeInterval } from "../shared/launchd-cron";
import { calendarEntriesFor, calendarScheduleFromEntries, type LaunchdSchedule, type LaunchdScheduleSpec } from "../shared/schedules";

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
export type PlistDict = { [key: string]: PlistValue };

/** Every job this plugin owns is a LaunchAgent whose label starts with this. */
export const LABEL_PREFIX = "com.noahfidel.schedules.";
/** The environment variable the runner reads its folder from. */
export const DIR_VARIABLE = "PASEO_SCHEDULES_DIR";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderValue(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === "boolean") return `${indent}<${value}/>\n`;
  if (typeof value === "number") return Number.isInteger(value) ? `${indent}<integer>${value}</integer>\n` : `${indent}<real>${value}</real>\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>\n`;
    return `${indent}<array>\n${value.map((entry) => renderValue(entry, `${indent}  `)).join("")}${indent}</array>\n`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return `${indent}<dict/>\n`;
  const body = keys.map((key) => `${indent}  <key>${escapeXml(key)}</key>\n${renderValue(value[key]!, `${indent}  `)}`).join("");
  return `${indent}<dict>\n${body}${indent}</dict>\n`;
}

/** An XML property list launchd and plutil read. */
export function renderPlist(dict: PlistDict): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n',
    '<plist version="1.0">\n',
    renderValue(dict, ""),
    "</plist>\n",
  ].join("");
}

const ENTRY_KEYS: ReadonlyArray<[keyof CalendarEntry, string]> = [
  ["minute", "Minute"],
  ["hour", "Hour"],
  ["day", "Day"],
  ["month", "Month"],
  ["weekday", "Weekday"],
];

/** The plist keys for a schedule the editor made. */
export function scheduleKeys(schedule: LaunchdScheduleSpec): PlistDict {
  if (schedule.type === "interval") return { StartInterval: schedule.minutes * 60 };
  const entries = calendarEntriesFor(schedule.times, schedule.weekdays).map((entry) => {
    const dict: PlistDict = {};
    for (const [field, key] of ENTRY_KEYS) if (entry[field] !== undefined) dict[key] = entry[field]!;
    return dict;
  });
  return { StartCalendarInterval: entries };
}

export interface JobPlistInput {
  label: string;
  slug: string;
  runner: string;
  command: string;
  cwd: string | null;
  path: string;
  dataDir: string;
  stderrPath: string;
  schedule: LaunchdScheduleSpec;
}

/**
 * The plist the runner shape is: launchd runs `/bin/zsh runner.sh <slug> <command>`,
 * and the runner writes the log and the run history. Only the runner's own
 * failures go to StandardErrorPath.
 */
export function jobPlist(input: JobPlistInput): PlistDict {
  return {
    Label: input.label,
    ProgramArguments: ["/bin/zsh", input.runner, input.slug, input.command],
    ...(input.cwd ? { WorkingDirectory: input.cwd } : {}),
    EnvironmentVariables: { PATH: input.path, [DIR_VARIABLE]: input.dataDir },
    ...scheduleKeys(input.schedule),
    StandardErrorPath: input.stderrPath,
  };
}

const PLIST_KEYS: Record<string, keyof CalendarEntry> = { Minute: "minute", Hour: "hour", Day: "day", Month: "month", Weekday: "weekday" };

export function calendarEntriesOf(value: unknown): CalendarEntry[] | null {
  if (value === undefined || value === null) return null;
  const dicts = Array.isArray(value) ? value : [value];
  const entries: CalendarEntry[] = [];
  for (const dict of dicts) {
    if (typeof dict !== "object" || dict === null) return null;
    const entry: CalendarEntry = {};
    for (const [key, field] of Object.entries(PLIST_KEYS)) {
      const raw = (dict as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
      entry[field] = raw;
    }
    entries.push(entry);
  }
  return entries;
}

/** When a plist on disk fires, in the editor's shape where it can be. */
export function scheduleOf(plist: Record<string, unknown>): LaunchdSchedule {
  if (typeof plist.StartInterval === "number" && plist.StartInterval > 0) {
    const seconds = Math.round(plist.StartInterval);
    return { type: "interval", seconds, description: describeInterval(seconds) };
  }
  const entries = calendarEntriesOf(plist.StartCalendarInterval);
  if (entries === null) return { type: "none", description: "Only when run by hand" };
  return calendarScheduleFromEntries(entries);
}

/** Calendar entries a plist fires on, for the next-run time. */
export function entriesOf(plist: Record<string, unknown>): CalendarEntry[] {
  return calendarEntriesOf(plist.StartCalendarInterval) ?? [];
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.:=+@%,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** The command as written when the plist is in the runner shape, else launchd's spawn line. */
export function commandOf(plist: Record<string, unknown>, runner: string): { command: string; managed: boolean } {
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.filter((entry): entry is string => typeof entry === "string") : [];
  if (args.length === 4 && args[0] === "/bin/zsh" && args[1] === runner) return { command: args[3] ?? "", managed: true };
  return { command: args.map(shellQuote).join(" "), managed: false };
}

export function environmentOf(plist: Record<string, unknown>): Record<string, string> {
  const env = plist.EnvironmentVariables;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Turns plutil's JSON back into plist values (drops nulls, which plists can't hold). */
export function toPlistDict(value: Record<string, unknown>): PlistDict {
  const convert = (entry: unknown): PlistValue | undefined => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return entry;
    if (Array.isArray(entry)) return entry.map(convert).filter((item): item is PlistValue => item !== undefined);
    if (typeof entry === "object" && entry !== null) return toPlistDict(entry as Record<string, unknown>);
    return undefined;
  };
  const out: PlistDict = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = convert(entry);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}
