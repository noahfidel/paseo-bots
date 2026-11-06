// Paseo's own schedules (`paseo schedule ls/inspect/pause/resume/run-once`).
// The plugin SDK's Paseo API has no schedules, so the daemon side runs the
// `paseo` CLI with --json; `PaseoSchedulesClient` keeps that swappable.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { describePaseoCadence, type LastRun, type PaseoRun, type ScheduleItem } from "../shared/schedules";

const exec = promisify(execFile);

const RunSchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable().default(null),
    status: z.enum(["running", "succeeded", "failed"]),
    agentId: z.string().nullable().default(null),
    output: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
  })
  .passthrough();

export const PaseoScheduleSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().default(null),
    prompt: z.string().default(""),
    cadence: z.union([z.object({ type: z.literal("every"), everyMs: z.number() }), z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().optional() })]),
    status: z.enum(["active", "paused", "completed"]),
    nextRunAt: z.string().nullable().default(null),
    lastRunAt: z.string().nullable().default(null),
    runs: z.array(RunSchema).default([]),
  })
  .passthrough();
export type PaseoSchedule = z.infer<typeof PaseoScheduleSchema>;

export interface PaseoSchedulesClient {
  list(): Promise<PaseoSchedule[]>;
  inspect(id: string): Promise<PaseoSchedule>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  runOnce(id: string): Promise<void>;
}

/** The newest run, by start time. */
function latestRun(schedule: PaseoSchedule): PaseoSchedule["runs"][number] | null {
  return [...schedule.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
}

export function paseoItem(schedule: PaseoSchedule): ScheduleItem {
  const run = latestRun(schedule);
  const lastRun: LastRun | null = run ? { id: run.id, status: run.status, at: run.endedAt ?? run.startedAt, error: run.error, agentId: run.agentId } : null;
  const cadence = describePaseoCadence(schedule.cadence);
  const prompt = schedule.prompt.trim();
  return {
    key: `paseo:${schedule.id}`,
    kind: "paseo",
    id: schedule.id,
    name: schedule.name?.trim() || (prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt) || schedule.id,
    schedule: schedule.status === "completed" ? `${cadence} · completed` : cadence,
    nextRunAt: schedule.status === "active" ? schedule.nextRunAt : null,
    paused: schedule.status === "paused",
    running: run?.status === "running",
    lastRun,
    failure: run?.status === "failed" ? (run.error?.trim() || "The run failed.") : null,
    paseo: { status: schedule.status, prompt: schedule.prompt },
  };
}

export function paseoRuns(schedule: PaseoSchedule): PaseoRun[] {
  return [...schedule.runs]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map((run) => ({ id: run.id, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, agentId: run.agentId, output: run.output, error: run.error }));
}

/** Where the `paseo` CLI is; the daemon's PATH is often bare. */
export function findPaseoCli(): string {
  const candidates = [process.env.PASEO_CLI, "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo", join(homedir(), ".local", "bin", "paseo")];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return "paseo";
}

type Runner = (args: string[]) => Promise<string>;

function cliRunner(): Runner {
  return async (args) => {
    const binary = findPaseoCli();
    const path = [binary.includes("/") ? dirname(binary) : null, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
    const home = process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : [];
    try {
      const { stdout } = await exec(binary, ["schedule", ...args, ...home, "--json"], { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: path } });
      return stdout;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const text = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim() || failure.message || String(error);
      throw new Error(`paseo schedule ${args[0]} failed: ${text.split("\n").slice(-3).join(" ").slice(0, 400)}`);
    }
  };
}

/** `paseo schedule ... --json`. `ls` gives summaries, `inspect` the full record with runs. */
export class PaseoCliSchedules implements PaseoSchedulesClient {
  constructor(private readonly run: Runner = cliRunner()) {}

  private async json(args: string[]): Promise<unknown> {
    const stdout = await this.run(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`paseo schedule ${args[0]} didn't return JSON.`);
    }
  }

  async list(): Promise<PaseoSchedule[]> {
    const rows = z.array(z.object({ id: z.string() }).passthrough()).parse(await this.json(["ls"]));
    return Promise.all(rows.map((row) => this.inspect(row.id)));
  }

  async inspect(id: string): Promise<PaseoSchedule> {
    return PaseoScheduleSchema.parse(await this.json(["inspect", id]));
  }

  async pause(id: string): Promise<void> {
    await this.json(["pause", id]);
  }

  async resume(id: string): Promise<void> {
    await this.json(["resume", id]);
  }

  async runOnce(id: string): Promise<void> {
    await this.json(["run-once", id]);
  }
}
