// launchd jobs for the Schedules screen: every `launchctl` call, the plists,
// the runner script, and the log and run-history files.
//
// Ported from @gpambrozio/paseo-launchd-jobs 0.6.0 (server/jobs.ts), MIT
// License, Copyright (c) 2026 Gustavo Ambrozio. Changes: its own label prefix
// and folder, an every-N-minutes or daily/weekly schedule instead of cron, a
// PATH the user can set, and launchctl behind `LaunchdEnv` so tests fake it.
//
// launchd is the scheduler and the store: nothing here keeps timers. Jobs are
// LaunchAgents labelled `com.noahfidel.schedules.<slug>` in ~/Library/LaunchAgents;
// the runner, logs/, runs/ and jobs.json live in the plugin's data folder.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LaunchdJobSpec, LaunchdSchedule, RunRecord } from "../shared/schedules";
import { pluginDataPath } from "./bot-home";
import { commandOf, DIR_VARIABLE, entriesOf, environmentOf, jobPlist, LABEL_PREFIX, renderPlist, scheduleOf, toPlistDict, type PlistDict } from "./launchd-plist";
import type { CalendarEntry } from "../shared/launchd-cron";

const exec = promisify(execFile);

const RUNNER_NAME = "runner.sh";
const LOG_TAIL_BYTES = 64 * 1024;
const RUNS_TAIL_BYTES = 64 * 1024;
const RECENT_RUNS = 20;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 400;

/** The plist keys a save writes; any other key of the job's plist (RunAtLoad, KeepAlive, StandardOutPath...) is kept. */
const OWNED_KEYS = ["Label", "Program", "ProgramArguments", "WorkingDirectory", "EnvironmentVariables", "StartInterval", "StartCalendarInterval", "StandardErrorPath"];

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Where jobs live and how launchd is reached. Tests swap all of it. */
export interface LaunchdEnv {
  platform: NodeJS.Platform;
  /** The user's home: plists go in <home>/Library/LaunchAgents. */
  home: string;
  /** This plugin's folder for the runner, logs/, runs/ and jobs.json. */
  dataDir: string;
  /** `$PASEO_HOME`, where launchd-jobs kept its files. */
  paseoHome: string;
  uid: number;
  launchctl(args: string[]): Promise<CommandResult>;
  /** A plist as JSON (plutil). */
  readPlist(path: string): Promise<Record<string, unknown>>;
  /** The PATH a new job gets when none is given. */
  loginPath(): Promise<string>;
  /** Waits between bootstrap attempts; tests make it instant. */
  sleep?(ms: number): Promise<void>;
}

function failureText(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const combined = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim();
  return combined === "" ? (failure.message ?? String(error)) : combined;
}

async function runLaunchctl(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec("launchctl", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
}

export async function plutilJson(path: string): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await exec("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
  } catch (error) {
    throw new Error(`Couldn't read ${path}: ${failureText(error)}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a dictionary`);
  return parsed as Record<string, unknown>;
}

/**
 * launchd hands agents a bare PATH, so Homebrew and version managers are
 * missing. The user's interactive login shell knows the real one; its last
 * line that looks like a PATH wins (startup files may print first).
 */
async function loginShellPath(): Promise<string> {
  for (const flags of ["-lic", "-lc"]) {
    try {
      const { stdout } = await exec("/bin/zsh", [flags, 'print -r -- "$PATH"'], { encoding: "utf8", timeout: 5000, env: { ...process.env, TERM: "dumb" } });
      const line = stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.includes("/"))
        .pop();
      if (line) return line;
    } catch (error) {
      console.warn(`paseo-bots: zsh ${flags} PATH probe failed: ${failureText(error)}`);
    }
  }
  return process.env.PATH ?? FALLBACK_PATH;
}

export function paseoHome(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

export function defaultLaunchdEnv(): LaunchdEnv {
  return {
    platform: process.platform,
    home: homedir(),
    dataDir: join(pluginDataPath(), "schedules"),
    paseoHome: paseoHome(),
    uid: process.getuid?.() ?? -1,
    launchctl: runLaunchctl,
    readPlist: plutilJson,
    loginPath: loginShellPath,
  };
}

/**
 * What launchd spawns: runs the command through a login shell between
 * `=== <time> start` and `=== <time> exit <code>` lines in the log, appends one
 * JSON line of history, and keeps both files bounded. The same format as
 * launchd-jobs' runner.sh, so adopted history reads the same.
 */
export const RUNNER_SCRIPT = [
  "#!/bin/zsh",
  "# Written by the paseo-bots Paseo plugin (Schedules); rewritten whenever a job is saved.",
  `# launchd runs it as: runner.sh <slug> <command>, with ${DIR_VARIABLE} set.`,
  "# Based on the runner of @gpambrozio/paseo-launchd-jobs (MIT).",
  "set -u",
  "zmodload zsh/datetime",
  'slug="$1"',
  'command="$2"',
  `dir="$${DIR_VARIABLE}"`,
  'log="$dir/logs/$slug.log"',
  'runs="$dir/runs/$slug.jsonl"',
  'mkdir -p "${log:h}" "${runs:h}"',
  'if [[ -f "$log" && $(stat -f %z "$log") -gt 1048576 ]]; then',
  '  mv -f "$log" "$log.1"',
  "fi",
  "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "start_time=$EPOCHREALTIME",
  "{",
  '  print -r -- "=== $started start"',
  '  /bin/zsh -lc "$command"',
  "  code=$?",
  '  print -r -- "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) exit $code"',
  '} >> "$log" 2>&1',
  "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_ms=$(printf '%.0f' $(( (EPOCHREALTIME - start_time) * 1000 )))",
  'print -r -- "{\\"startedAt\\":\\"$started\\",\\"finishedAt\\":\\"$finished\\",\\"exitCode\\":$code,\\"durationMs\\":$duration_ms}" >> "$runs"',
  'if [[ $(stat -f %z "$runs") -gt 262144 ]]; then',
  '  tail -n 200 "$runs" > "$runs.tmp" && mv -f "$runs.tmp" "$runs"',
  "fi",
  "exit $code",
  "",
].join("\n");

export interface LaunchdJob {
  id: string;
  label: string;
  name: string;
  command: string;
  cwd: string | null;
  path: string | null;
  schedule: LaunchdSchedule;
  entries: CalendarEntry[];
  managed: boolean;
  loaded: boolean;
  disabled: boolean;
  running: boolean;
  lastExitCode: number | null;
  /** Most recent first. */
  recentRuns: RunRecord[];
  plistPath: string;
  logPath: string;
  problem: string | null;
}

export interface JobsFile {
  names: Record<string, string>;
  /** Slug → the launchd-jobs label it was adopted from. */
  adopted: Record<string, string>;
}

interface LaunchdStatus {
  loaded: boolean;
  running: boolean;
  lastExitCode: number | null;
}

const UNLOADED: LaunchdStatus = { loaded: false, running: false, lastExitCode: null };

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

export function statusOf(output: string): LaunchdStatus {
  const state = /^\s*state = (.+?)\s*$/m.exec(output)?.[1] ?? "";
  const exit = /^\s*last exit code = (-?\d+)\s*$/m.exec(output)?.[1];
  return { loaded: true, running: state.startsWith("running"), lastExitCode: exit === undefined ? null : Number(exit) };
}

function toRunRecord(line: string): RunRecord | null {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (typeof record.startedAt !== "string" || typeof record.finishedAt !== "string" || typeof record.exitCode !== "number" || typeof record.durationMs !== "number") return null;
    return { startedAt: record.startedAt, finishedAt: record.finishedAt, exitCode: Math.round(record.exitCode), durationMs: Math.max(0, Math.round(record.durationMs)) };
  } catch {
    return null;
  }
}

/** The last `bytes` of a file from its first whole line; a missing file is empty. */
export async function readTail(path: string, bytes: number): Promise<{ text: string; truncated: boolean }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return { text: "", truncated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "job" : slug;
}

/** Writes a file another process may read at any moment: to a temp file, then renamed over. */
export async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class LaunchdJobs {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(readonly env: LaunchdEnv = defaultLaunchdEnv()) {}

  /**
   * Runs `task` after every earlier one has finished. Everything that writes
   * jobs.json or moves a job in launchd goes through here (the RPCs and the
   * adoption on load), so no write is lost to another. Not reentrant.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task);
    this.lock = next.catch(() => {});
    return next;
  }

  get supported(): boolean {
    return this.env.platform === "darwin";
  }

  // ---------------------------------------------------------------- paths

  get launchAgentsDir(): string {
    return join(this.env.home, "Library", "LaunchAgents");
  }

  get domain(): string {
    return `gui/${this.env.uid}`;
  }

  labelFor(slug: string): string {
    return `${LABEL_PREFIX}${slug}`;
  }

  plistPath(slug: string): string {
    return join(this.launchAgentsDir, `${this.labelFor(slug)}.plist`);
  }

  logPath(slug: string): string {
    return join(this.env.dataDir, "logs", `${slug}.log`);
  }

  runsPath(slug: string): string {
    return join(this.env.dataDir, "runs", `${slug}.jsonl`);
  }

  get runnerPath(): string {
    return join(this.env.dataDir, RUNNER_NAME);
  }

  private get jobsFilePath(): string {
    return join(this.env.dataDir, "jobs.json");
  }

  // ---------------------------------------------------------------- launchctl

  async launchctl(args: string[]): Promise<string> {
    const result = await this.env.launchctl(args);
    if (result.code !== 0) throw new Error(`launchctl ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    return result.stdout;
  }

  /** `launchctl print` for one label, or null when launchd doesn't have it. */
  async printService(label: string): Promise<string | null> {
    const result = await this.env.launchctl(["print", `${this.domain}/${label}`]);
    if (result.code === 0) return result.stdout;
    if (result.code === 113 || /Could not find service/.test(result.stderr + result.stdout)) return null;
    throw new Error(`launchctl print ${label} failed: ${(result.stderr || result.stdout).trim()}`);
  }

  async readStatus(label: string): Promise<LaunchdStatus> {
    const output = await this.printService(label);
    return output === null ? UNLOADED : statusOf(output);
  }

  async readDisabled(): Promise<Set<string>> {
    const output = await this.launchctl(["print-disabled", this.domain]);
    const disabled = new Set<string>();
    for (const match of output.matchAll(/"([^"]+)" => (disabled|true)/g)) if (match[1]) disabled.add(match[1]);
    return disabled;
  }

  /** Ignores "not loaded"; anything else is a real failure. */
  async bootoutIfLoaded(label: string): Promise<void> {
    const result = await this.env.launchctl(["bootout", `${this.domain}/${label}`]);
    if (result.code === 0) return;
    const text = result.stderr + result.stdout;
    if (result.code === 113 || result.code === 3 || /No such process|Could not find service/.test(text)) return;
    throw new Error(`launchctl bootout ${label} failed: ${text.trim() || `exit ${result.code}`}`);
  }

  async bootstrapPlist(path: string): Promise<void> {
    await this.launchctl(["bootstrap", this.domain, path]);
  }

  /**
   * Bootstraps, trying again a few times: launchd often refuses a label it has
   * just booted out ("5: Input/output error", "37: Operation already in progress").
   */
  async bootstrapWithRetry(path: string, attempts = BOOTSTRAP_ATTEMPTS): Promise<void> {
    const sleep = this.env.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.bootstrapPlist(path);
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(BOOTSTRAP_RETRY_MS * attempt);
      }
    }
  }

  // ---------------------------------------------------------------- files

  async readJobsFile(): Promise<JobsFile> {
    try {
      const parsed = JSON.parse(await readFile(this.jobsFilePath, "utf8")) as Partial<JobsFile>;
      return { names: { ...(parsed.names ?? {}) }, adopted: { ...(parsed.adopted ?? {}) } };
    } catch (error) {
      if (!isMissing(error)) console.warn(`paseo-bots: ignoring unreadable ${this.jobsFilePath}: ${String(error)}`);
      return { names: {}, adopted: {} };
    }
  }

  /** Only inside `exclusive`. */
  async writeJobsFile(file: JobsFile): Promise<void> {
    await mkdir(this.env.dataDir, { recursive: true });
    await writeAtomic(this.jobsFilePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  async ensureRunner(): Promise<string> {
    await mkdir(join(this.env.dataDir, "logs"), { recursive: true });
    await mkdir(join(this.env.dataDir, "runs"), { recursive: true });
    let current: string | null = null;
    try {
      current = await readFile(this.runnerPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (current !== RUNNER_SCRIPT) await writeAtomic(this.runnerPath, RUNNER_SCRIPT, 0o755);
    return this.runnerPath;
  }

  async readRuns(slug: string): Promise<RunRecord[]> {
    const { text } = await readTail(this.runsPath(slug), RUNS_TAIL_BYTES);
    const records = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(toRunRecord)
      .filter((record): record is RunRecord => record !== null);
    return records.slice(-RECENT_RUNS).reverse();
  }

  async listSlugs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.launchAgentsDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names
      .filter((name) => name.startsWith(LABEL_PREFIX) && name.endsWith(".plist"))
      .map((name) => name.slice(LABEL_PREFIX.length, -".plist".length))
      .sort();
  }

  // ---------------------------------------------------------------- reading jobs

  private async readJob(slug: string, disabled: ReadonlySet<string>, file: JobsFile): Promise<LaunchdJob> {
    const label = this.labelFor(slug);
    const base = { id: slug, label, name: file.names[slug] ?? slug, plistPath: this.plistPath(slug), logPath: this.logPath(slug), disabled: disabled.has(label) };
    const [plistResult, status, recentRuns] = await Promise.all([
      this.env.readPlist(base.plistPath).then(
        (plist) => ({ plist, problem: null as string | null }),
        (error: unknown) => ({ plist: null, problem: `Couldn't read the plist: ${failureText(error)}` }),
      ),
      this.readStatus(label).catch(() => UNLOADED),
      this.readRuns(slug),
    ]);
    if (!plistResult.plist) {
      return { ...base, command: "", cwd: null, path: null, schedule: { type: "none", description: "Unknown" }, entries: [], managed: false, ...status, recentRuns, problem: plistResult.problem };
    }
    const plist = plistResult.plist;
    const { command, managed } = commandOf(plist, this.runnerPath);
    return {
      ...base,
      command,
      cwd: typeof plist.WorkingDirectory === "string" ? plist.WorkingDirectory : null,
      path: environmentOf(plist).PATH ?? null,
      schedule: scheduleOf(plist),
      entries: entriesOf(plist),
      managed,
      ...status,
      recentRuns,
      problem: null,
    };
  }

  async list(): Promise<LaunchdJob[]> {
    if (!this.supported) return [];
    const [slugs, disabled, file] = await Promise.all([this.listSlugs(), this.readDisabled(), this.readJobsFile()]);
    return Promise.all(slugs.map((slug) => this.readJob(slug, disabled, file)));
  }

  async get(slug: string): Promise<LaunchdJob> {
    const [disabled, file] = await Promise.all([this.readDisabled(), this.readJobsFile()]);
    return this.readJob(slug, disabled, file);
  }

  /** The newest run of every job, without asking launchctl (the alert poll). */
  async latestRuns(): Promise<{ id: string; name: string; run: RunRecord | null }[]> {
    if (!this.supported) return [];
    const [slugs, file] = await Promise.all([this.listSlugs(), this.readJobsFile()]);
    return Promise.all(slugs.map(async (slug) => ({ id: slug, name: file.names[slug] ?? slug, run: (await this.readRuns(slug))[0] ?? null })));
  }

  async log(slug: string): Promise<{ text: string; truncated: boolean; path: string; runs: RunRecord[] }> {
    const path = this.logPath(slug);
    const [tail, runs] = await Promise.all([readTail(path, LOG_TAIL_BYTES), this.readRuns(slug)]);
    return { ...tail, path, runs };
  }

  // ---------------------------------------------------------------- writing jobs

  private assertSupported(): void {
    if (!this.supported) throw new Error("launchd jobs are only available when Paseo runs on macOS.");
  }

  private async assertKnown(slug: string): Promise<void> {
    try {
      await stat(this.plistPath(slug));
    } catch (error) {
      if (isMissing(error)) throw new Error(`No job "${slug}" in ${this.launchAgentsDir}.`);
      throw error;
    }
  }

  private normaliseCwd(cwd: string | null | undefined): string | null | undefined {
    if (cwd === undefined || cwd === null) return cwd;
    if (cwd === "") return null;
    if (cwd === "~" || cwd.startsWith("~/")) return join(this.env.home, cwd.slice(1));
    if (!cwd.startsWith("/")) throw new Error("The working directory must be an absolute path.");
    return cwd;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const taken = new Set(await this.listSlugs());
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  /** Writes the job's plist; `current` is the plist it replaces, whose other keys are kept. */
  private async writeJob(slug: string, spec: LaunchdJobSpec, cwd: string | null, current: Record<string, unknown> = {}): Promise<void> {
    const runner = await this.ensureRunner();
    const path = spec.path ?? (await this.env.loginPath());
    const file = await this.readJobsFile();
    file.names[slug] = spec.name;
    await this.writeJobsFile(file);
    await mkdir(this.launchAgentsDir, { recursive: true });
    const fresh = jobPlist({
      label: this.labelFor(slug),
      slug,
      runner,
      command: spec.command,
      cwd,
      path,
      dataDir: this.env.dataDir,
      stderrPath: this.logPath(slug),
      schedule: spec.schedule,
    });
    const kept: PlistDict = toPlistDict(current);
    for (const key of OWNED_KEYS) delete kept[key];
    // Other environment variables the plist had stay too; PATH and the data folder are ours.
    const environment: PlistDict = { ...environmentOf(current), ...(fresh.EnvironmentVariables as PlistDict) };
    await writeFile(this.plistPath(slug), renderPlist({ ...fresh, EnvironmentVariables: environment, ...kept }), "utf8");
  }

  async create(spec: LaunchdJobSpec): Promise<string> {
    this.assertSupported();
    return this.exclusive(async () => {
      const slug = await this.uniqueSlug(spec.name);
      await this.writeJob(slug, spec, this.normaliseCwd(spec.cwd) ?? null);
      // The plist stays if launchd refuses it: the list shows it unloaded, and Resume retries.
      await this.bootstrapPlist(this.plistPath(slug));
      return slug;
    });
  }

  async update(slug: string, spec: LaunchdJobSpec): Promise<string> {
    this.assertSupported();
    return this.exclusive(async () => {
      await this.assertKnown(slug);
      const label = this.labelFor(slug);
      const current = await this.env.readPlist(this.plistPath(slug)).catch(() => ({}) as Record<string, unknown>);
      const cwd = spec.cwd === undefined ? (typeof current.WorkingDirectory === "string" ? current.WorkingDirectory : null) : (this.normaliseCwd(spec.cwd) ?? null);
      const disabled = (await this.readDisabled()).has(label);
      // launchd doesn't reread a changed plist; the job has to leave and come back.
      await this.bootoutIfLoaded(label);
      await this.writeJob(slug, spec, cwd, current);
      if (!disabled) await this.bootstrapWithRetry(this.plistPath(slug));
      return slug;
    });
  }

  async remove(slug: string): Promise<void> {
    this.assertSupported();
    return this.exclusive(() => this.removeNow(slug));
  }

  private async removeNow(slug: string): Promise<void> {
    await this.assertKnown(slug);
    const label = this.labelFor(slug);
    await this.bootoutIfLoaded(label);
    // A disable outlives the plist; clear it so a later job with this slug isn't born paused.
    await this.launchctl(["enable", `${this.domain}/${label}`]).catch((error: unknown) => console.warn(`paseo-bots: couldn't clear the disabled flag for ${label}: ${String(error)}`));
    for (const path of [this.plistPath(slug), this.logPath(slug), `${this.logPath(slug)}.1`, this.runsPath(slug)]) {
      await unlink(path).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    const file = await this.readJobsFile();
    delete file.names[slug];
    delete file.adopted[slug];
    await this.writeJobsFile(file);
  }

  async run(slug: string): Promise<void> {
    this.assertSupported();
    await this.assertKnown(slug);
    const label = this.labelFor(slug);
    if (!(await this.readStatus(label)).loaded) throw new Error("The job isn't loaded; resume it first.");
    await this.launchctl(["kickstart", `${this.domain}/${label}`]);
  }

  async setEnabled(slug: string, enabled: boolean): Promise<void> {
    this.assertSupported();
    return this.exclusive(async () => {
      await this.assertKnown(slug);
      const label = this.labelFor(slug);
      if (enabled) {
        // enable first: bootstrapping a disabled label is refused.
        await this.launchctl(["enable", `${this.domain}/${label}`]);
        await this.bootoutIfLoaded(label);
        await this.bootstrapWithRetry(this.plistPath(slug));
      } else {
        await this.bootoutIfLoaded(label);
        await this.launchctl(["disable", `${this.domain}/${label}`]);
      }
    });
  }
}
