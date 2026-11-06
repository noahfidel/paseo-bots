import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchdJobs, plutilJson, RUNNER_SCRIPT, type CommandResult, type LaunchdEnv } from "../server/launchd";
import { adoptLaunchdJobs, OLD_PREFIX } from "../server/launchd-adopt";
import { commandOf, jobPlist, renderPlist, scheduleOf } from "../server/launchd-plist";
import type { LaunchdScheduleSpec } from "../shared/schedules";

const onMac = process.platform === "darwin";
const UID = 501;

/** launchd's gui domain, in memory: what's loaded, what's disabled, and every call. */
class FakeLaunchctl {
  loaded = new Map<string, { path: string; running: boolean }>();
  disabled = new Set<string>();
  calls: string[][] = [];
  /** Labels whose bootstrap fails. */
  refuse = new Set<string>();
  /** Labels whose next N bootstraps fail, as launchd does right after a bootout. */
  refuseTimes = new Map<string, number>();
  /** The process "dies" after this call: it's carried out, and its caller never hears back. */
  crashAfter: ((args: string[]) => boolean) | null = null;
  /** Checked before every call. */
  beforeCall: (() => void) | null = null;
  delayMs = 0;

  run = async (args: string[]): Promise<CommandResult> => {
    this.beforeCall?.();
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const result = await this.carryOut(args);
    if (this.crashAfter?.(args)) return new Promise<CommandResult>(() => {});
    return result;
  };

  private carryOut = async (args: string[]): Promise<CommandResult> => {
    this.calls.push(args);
    const [verb, target = "", path = ""] = args;
    const label = target.replace(`gui/${UID}/`, "");
    const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });
    const fail = (code: number, stderr: string): CommandResult => ({ stdout: "", stderr, code });
    switch (verb) {
      case "print": {
        const job = this.loaded.get(label);
        if (!job) return fail(113, `Could not find service "${label}" in domain for user gui: ${UID}`);
        return ok(`${label} = {\n\tpath = ${job.path}\n\tstate = ${job.running ? "running" : "not running"}\n\truns = 1\n\tlast exit code = 0\n}`);
      }
      case "print-disabled":
        return ok(`disabled services = {\n${[...this.disabled].map((entry) => `\t"${entry}" => disabled\n`).join("")}}\n`);
      case "bootout":
        if (!this.loaded.delete(label)) return fail(3, "Boot-out failed: 3: No such process");
        return ok();
      case "bootstrap": {
        const plist = await plutilJson(path);
        const plistLabel = String(plist.Label);
        if (this.refuse.has(plistLabel) || this.disabled.has(plistLabel)) return fail(5, "Bootstrap failed: 5: Input/output error");
        const times = this.refuseTimes.get(plistLabel) ?? 0;
        if (times > 0) {
          this.refuseTimes.set(plistLabel, times - 1);
          return fail(37, "Bootstrap failed: 37: Operation already in progress");
        }
        if (this.loaded.has(plistLabel)) return fail(5, "Bootstrap failed: 5: Input/output error");
        this.loaded.set(plistLabel, { path, running: false });
        return ok();
      }
      case "enable":
        this.disabled.delete(label);
        return ok();
      case "disable":
        this.disabled.add(label);
        return ok();
      case "kickstart":
        return this.loaded.has(label) ? ok() : fail(113, "Could not find service");
      default:
        return fail(64, `unknown ${verb}`);
    }
  };

  verbs(): string[] {
    return this.calls.map((call) => call[0]!);
  }

  bootstraps(label: string): number {
    return this.calls.filter((call) => call[0] === "bootstrap" && call[2]!.endsWith(`/${label}.plist`)).length;
  }
}

let root: string;
let fake: FakeLaunchctl;
let env: LaunchdEnv;
let jobs: LaunchdJobs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "schedules-test-"));
  fake = new FakeLaunchctl();
  env = {
    platform: "darwin",
    home: join(root, "home"),
    dataDir: join(root, "home", ".paseo", "plugin-data", "paseo-bots", "schedules"),
    paseoHome: join(root, "home", ".paseo"),
    uid: UID,
    launchctl: fake.run,
    readPlist: plutilJson,
    loginPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
    sleep: async () => {},
  };
  jobs = new LaunchdJobs(env);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function parsed(dict: ReturnType<typeof jobPlist>): Promise<Record<string, unknown>> {
  const path = join(root, "probe.plist");
  writeFileSync(path, renderPlist(dict));
  return plutilJson(path);
}

function plistFor(schedule: LaunchdScheduleSpec) {
  return jobPlist({
    label: "com.noahfidel.schedules.x",
    slug: "x",
    runner: "/data/runner.sh",
    command: `echo "a & b" <ok>`,
    cwd: "/tmp",
    path: "/usr/bin:/bin",
    dataDir: "/data",
    stderrPath: "/data/logs/x.log",
    schedule,
  });
}

describe.skipIf(!onMac)("plist render and parse", () => {
  it("every N minutes", async () => {
    const plist = await parsed(plistFor({ type: "interval", minutes: 15 }));
    expect(plist.StartInterval).toBe(900);
    expect(scheduleOf(plist)).toEqual({ type: "interval", seconds: 900, description: "Every 15 minutes" });
    expect(commandOf(plist, "/data/runner.sh")).toEqual({ command: `echo "a & b" <ok>`, managed: true });
    expect(plist.EnvironmentVariables).toEqual({ PATH: "/usr/bin:/bin", PASEO_SCHEDULES_DIR: "/data" });
    expect(plist.WorkingDirectory).toBe("/tmp");
  });

  it("daily at set times", async () => {
    const plist = await parsed(plistFor({ type: "calendar", times: ["09:00", "17:30"], weekdays: [] }));
    expect(plist.StartCalendarInterval).toEqual([
      { Hour: 9, Minute: 0 },
      { Hour: 17, Minute: 30 },
    ]);
    expect(scheduleOf(plist)).toEqual({ type: "calendar", times: ["09:00", "17:30"], weekdays: [], description: "Every day at 09:00 and 17:30" });
  });

  it("weekly at set times", async () => {
    const plist = await parsed(plistFor({ type: "calendar", times: ["08:00"], weekdays: [1, 2, 3, 4, 5] }));
    expect(plist.StartCalendarInterval).toHaveLength(5);
    expect(scheduleOf(plist)).toEqual({ type: "calendar", times: ["08:00"], weekdays: [1, 2, 3, 4, 5], description: "Mon–Fri at 08:00" });
  });

  it("a hand-made calendar reads as custom, and no schedule as run-by-hand", async () => {
    const custom = await parsed({ Label: "x", StartCalendarInterval: { Minute: 0, Hour: 6, Day: 1 } });
    expect(scheduleOf(custom)).toEqual({ type: "custom", description: "At 06:00 on day 1" });
    expect(scheduleOf(await parsed({ Label: "x" })).type).toBe("none");
  });
});

describe.skipIf(!onMac)("LaunchdJobs", () => {
  it("creates, edits, pauses, resumes and deletes a job", async () => {
    const id = await jobs.create({ name: "Test job", command: "echo hi", schedule: { type: "interval", minutes: 1 }, path: null });
    expect(id).toBe("test-job");
    const label = "com.noahfidel.schedules.test-job";
    expect(fake.loaded.has(label)).toBe(true);
    expect(readFileSync(jobs.runnerPath, "utf8")).toBe(RUNNER_SCRIPT);

    let [job] = await jobs.list();
    expect(job).toMatchObject({ id, name: "Test job", command: "echo hi", loaded: true, disabled: false, managed: true, path: "/opt/homebrew/bin:/usr/bin:/bin" });
    expect(job!.schedule).toEqual({ type: "interval", seconds: 60, description: "Every minute" });

    await jobs.update(id, { name: "Test job", command: "echo hi", schedule: { type: "interval", minutes: 2 }, path: "/usr/bin:/bin" });
    expect((await plutilJson(jobs.plistPath(id))).StartInterval).toBe(120);
    expect(fake.loaded.has(label)).toBe(true);

    await jobs.setEnabled(id, false);
    expect(fake.disabled.has(label)).toBe(true);
    expect(fake.loaded.has(label)).toBe(false);
    [job] = await jobs.list();
    expect(job).toMatchObject({ disabled: true, loaded: false, path: "/usr/bin:/bin" });

    await jobs.setEnabled(id, true);
    expect(fake.loaded.has(label)).toBe(true);
    await jobs.run(id);
    expect(fake.calls.at(-1)).toEqual(["kickstart", `gui/${UID}/${label}`]);

    await jobs.remove(id);
    expect(existsSync(jobs.plistPath(id))).toBe(false);
    expect(fake.loaded.has(label)).toBe(false);
    expect(await jobs.list()).toEqual([]);
  });

  it("keeps the plist keys it doesn't write when a job is saved", async () => {
    mkdirSync(jobs.launchAgentsDir, { recursive: true });
    const path = jobs.plistPath("hand");
    writeFileSync(
      path,
      renderPlist({
        Label: "com.noahfidel.schedules.hand",
        ProgramArguments: ["/usr/bin/true"],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        StandardOutPath: "/tmp/hand.out",
        StandardErrorPath: "/tmp/hand.err",
        EnvironmentVariables: { TOKEN_FILE: "/tmp/t", PATH: "/old" },
        StartInterval: 300,
      }),
    );
    await jobs.update("hand", { name: "Hand", command: "echo hand", schedule: { type: "interval", minutes: 10 }, path: "/usr/bin:/bin" });
    const plist = await plutilJson(path);
    expect(plist).toMatchObject({
      Label: "com.noahfidel.schedules.hand",
      ProgramArguments: ["/bin/zsh", jobs.runnerPath, "hand", "echo hand"],
      StartInterval: 600,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: "/tmp/hand.out",
      StandardErrorPath: jobs.logPath("hand"),
      EnvironmentVariables: { TOKEN_FILE: "/tmp/t", PATH: "/usr/bin:/bin", PASEO_SCHEDULES_DIR: env.dataDir },
    });
    // A switch to set times drops StartInterval rather than keeping both.
    await jobs.update("hand", { name: "Hand", command: "echo hand", schedule: { type: "calendar", times: ["09:00"], weekdays: [] }, path: "/bin" });
    const calendar = await plutilJson(path);
    expect(calendar.StartInterval).toBeUndefined();
    expect(calendar.StartCalendarInterval).toEqual([{ Hour: 9, Minute: 0 }]);
    expect(calendar.RunAtLoad).toBe(true);
  });

  it("reads run history newest first and the log tail", async () => {
    const id = await jobs.create({ name: "h", command: "true", schedule: { type: "interval", minutes: 5 }, path: "/bin" });
    mkdirSync(join(env.dataDir, "runs"), { recursive: true });
    writeFileSync(jobs.runsPath(id), ['{"startedAt":"a","finishedAt":"a","exitCode":0,"durationMs":5}', '{"startedAt":"b","finishedAt":"b","exitCode":2,"durationMs":5}', "junk"].join("\n"));
    writeFileSync(jobs.logPath(id), "=== a start\nhi\n=== a exit 0\n");
    const log = await jobs.log(id);
    expect(log.runs.map((run) => run.exitCode)).toEqual([2, 0]);
    expect(log.text).toContain("hi");
    expect((await jobs.latestRuns())[0]!.run?.startedAt).toBe("b");
  });
});

// ---------------------------------------------------------------- adoption

const OLD_SLUG = "pr-watch";
const OLD_LABEL = `${OLD_PREFIX}${OLD_SLUG}`;

function seedOldJob(options: { loaded?: boolean; running?: boolean; disabled?: boolean } = {}) {
  const oldDir = join(env.paseoHome, "plugin-data", "launchd-jobs");
  mkdirSync(join(oldDir, "runs"), { recursive: true });
  mkdirSync(join(oldDir, "logs"), { recursive: true });
  writeFileSync(join(oldDir, "runner.sh"), "#!/bin/zsh\n");
  writeFileSync(join(oldDir, "jobs.json"), JSON.stringify({ names: { [OLD_SLUG]: "PR review watch" } }));
  writeFileSync(join(oldDir, "runs", `${OLD_SLUG}.jsonl`), '{"startedAt":"2026-11-01T00:00:00Z","finishedAt":"2026-11-01T00:00:01Z","exitCode":0,"durationMs":900}\n{"startedAt":"2026-11-02T00:00:00Z","finishedAt":"2026-11-02T00:00:01Z","exitCode":1,"durationMs":800}\n');
  writeFileSync(join(oldDir, "logs", `${OLD_SLUG}.log`), "=== 2026-11-02T00:00:00Z start\nold output\n=== 2026-11-02T00:00:01Z exit 1\n");
  mkdirSync(jobs.launchAgentsDir, { recursive: true });
  const oldPlist = join(jobs.launchAgentsDir, `${OLD_LABEL}.plist`);
  writeFileSync(
    oldPlist,
    renderPlist({
      Label: OLD_LABEL,
      ProgramArguments: ["/bin/zsh", join(oldDir, "runner.sh"), OLD_SLUG, "gh pr list"],
      EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/bin", PASEO_LAUNCHD_JOBS_DIR: oldDir },
      StartCalendarInterval: [{ Minute: 0, Hour: 9, Weekday: 1 }],
      StandardErrorPath: join(oldDir, "logs", `${OLD_SLUG}.log`),
    }),
  );
  const other = join(jobs.launchAgentsDir, "com.example.other.plist");
  writeFileSync(other, renderPlist({ Label: "com.example.other", ProgramArguments: ["/usr/bin/true"] }));
  if (options.loaded !== false) fake.loaded.set(OLD_LABEL, { path: oldPlist, running: options.running ?? false });
  if (options.disabled) {
    fake.loaded.delete(OLD_LABEL);
    fake.disabled.add(OLD_LABEL);
  }
  return { oldDir, oldPlist, other, otherText: readFileSync(other, "utf8") };
}

const NEW_LABEL = "com.noahfidel.schedules.pr-watch";

/** Fails the test if both plists are ever in LaunchAgents at once (a login then would start both). */
function neverBoth(oldPlist: string): string[] {
  const seen: string[] = [];
  fake.beforeCall = () => {
    if (existsSync(oldPlist) && existsSync(jobs.plistPath(OLD_SLUG))) seen.push(fake.calls.at(-1)?.join(" ") ?? "start");
  };
  return seen;
}

describe.skipIf(!onMac)("adopting launchd-jobs' jobs", () => {
  it("moves the job to our label, runner and folder, and backs up the old plist", async () => {
    const { oldPlist, other, otherText } = seedOldJob();
    const both = neverBoth(oldPlist);
    const result = await adoptLaunchdJobs(jobs);
    expect(both).toEqual([]);
    expect(readdirSync(join(env.dataDir, "adopting"))).toEqual([]);
    expect(result).toEqual({ adopted: [{ from: OLD_LABEL, to: "com.noahfidel.schedules.pr-watch" }], skipped: [], failed: [] });

    expect(fake.loaded.has(OLD_LABEL)).toBe(false);
    expect(fake.loaded.has("com.noahfidel.schedules.pr-watch")).toBe(true);
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(join(env.dataDir, "adopted", `${OLD_LABEL}.plist`))).toBe(true);

    const text = readFileSync(jobs.plistPath(OLD_SLUG), "utf8");
    expect(text).not.toContain("launchd-jobs");
    const [job] = await jobs.list();
    expect(job).toMatchObject({ id: OLD_SLUG, name: "PR review watch", command: "gh pr list", managed: true, loaded: true, path: "/opt/homebrew/bin:/usr/bin" });
    expect(job!.schedule).toEqual({ type: "calendar", times: ["09:00"], weekdays: [1], description: "Mon at 09:00" });
    expect(job!.recentRuns.map((run) => run.exitCode)).toEqual([1, 0]);
    expect((await jobs.log(OLD_SLUG)).text).toContain("old output");

    // No other LaunchAgent was touched.
    expect(readFileSync(other, "utf8")).toBe(otherText);
    expect(fake.calls.every((call) => !call.join(" ").includes("com.example.other"))).toBe(true);
  });

  it("does nothing the second time", async () => {
    seedOldJob();
    await adoptLaunchdJobs(jobs);
    const before = fake.calls.length;
    const plist = readFileSync(jobs.plistPath(OLD_SLUG), "utf8");
    expect(await adoptLaunchdJobs(jobs)).toEqual({ adopted: [], skipped: [], failed: [] });
    expect(fake.calls.length).toBe(before);
    expect(readFileSync(jobs.plistPath(OLD_SLUG), "utf8")).toBe(plist);
    expect(fake.loaded.has("com.noahfidel.schedules.pr-watch")).toBe(true);
  });

  it("finishes a move an earlier start cut short", async () => {
    const { oldPlist } = seedOldJob();
    fake.refuse.add("com.noahfidel.schedules.pr-watch");
    await adoptLaunchdJobs(jobs);
    fake.refuse.clear();
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toHaveLength(1);
    expect(existsSync(oldPlist)).toBe(false);
    // History merged once, not twice.
    expect((await jobs.readRuns(OLD_SLUG)).length).toBe(2);
  });

  it("keeps the old job running when the new one won't load", async () => {
    const { oldPlist } = seedOldJob();
    fake.refuse.add("com.noahfidel.schedules.pr-watch");
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toEqual([]);
    expect(result.failed.map((entry) => entry.label)).toEqual([OLD_LABEL]);
    expect(fake.loaded.has(OLD_LABEL)).toBe(true);
    expect(existsSync(oldPlist)).toBe(true);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(false);
    expect(await jobs.list()).toEqual([]);
  });

  it("loads the old job again even when launchd refuses it at first", async () => {
    const { oldPlist } = seedOldJob();
    fake.refuse.add(NEW_LABEL);
    fake.refuseTimes.set(OLD_LABEL, 2);
    const result = await adoptLaunchdJobs(jobs);
    expect(result.failed.map((entry) => entry.label)).toEqual([OLD_LABEL]);
    expect(fake.loaded.get(OLD_LABEL)?.path).toBe(oldPlist);
    expect(fake.bootstraps(OLD_LABEL)).toBe(3);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(false);
  });

  it("keeps the note when the old job can't be loaded again, so the next start still runs the job", async () => {
    const { oldPlist } = seedOldJob();
    fake.refuse.add(NEW_LABEL);
    fake.refuse.add(OLD_LABEL);
    expect((await adoptLaunchdJobs(jobs)).failed).toHaveLength(1);
    expect(fake.loaded.size).toBe(0);
    expect(existsSync(oldPlist)).toBe(true);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(false);

    fake.refuse.clear();
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toEqual([{ from: OLD_LABEL, to: NEW_LABEL }]);
    expect(fake.loaded.has(NEW_LABEL)).toBe(true);
    expect(existsSync(oldPlist)).toBe(false);
  });

  it("after a crash between the old job's bootout and the new one's bootstrap, the next start runs the job", async () => {
    const { oldPlist } = seedOldJob();
    fake.crashAfter = (args) => args[0] === "bootout" && args[1]!.endsWith(OLD_LABEL);
    void adoptLaunchdJobs(jobs);
    await vi.waitFor(() => expect(fake.loaded.has(OLD_LABEL)).toBe(false));
    expect(existsSync(oldPlist)).toBe(true);

    // The plugin starts again: a new process, the same launchd and files.
    fake.crashAfter = null;
    const result = await adoptLaunchdJobs(new LaunchdJobs(env));
    expect(result).toMatchObject({ adopted: [{ from: OLD_LABEL, to: NEW_LABEL }], failed: [] });
    expect(fake.loaded.has(NEW_LABEL)).toBe(true);
    expect(existsSync(oldPlist)).toBe(false);
  });

  it("after a crash once the plists have moved, the next start loads the new job", async () => {
    const { oldPlist } = seedOldJob();
    const both = neverBoth(oldPlist);
    fake.crashAfter = (args) => args[0] === "bootout" && args[1]!.endsWith(NEW_LABEL);
    void adoptLaunchdJobs(jobs);
    await vi.waitFor(() => expect(fake.calls.some((call) => call[0] === "bootout" && call[1]!.endsWith(NEW_LABEL))).toBe(true));
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(true);
    expect(fake.loaded.size).toBe(0);

    fake.crashAfter = null;
    const result = await adoptLaunchdJobs(new LaunchdJobs(env));
    expect(result.adopted).toEqual([{ from: OLD_LABEL, to: NEW_LABEL }]);
    expect(fake.loaded.has(NEW_LABEL)).toBe(true);
    expect(both).toEqual([]);
    expect((await jobs.readRuns(OLD_SLUG)).length).toBe(2);
  });

  it("leaves an old job that was booted out by hand unloaded", async () => {
    const { oldPlist } = seedOldJob({ loaded: false });
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toEqual([{ from: OLD_LABEL, to: NEW_LABEL }]);
    expect(fake.verbs()).not.toContain("bootstrap");
    expect(fake.loaded.size).toBe(0);
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(true);
    const [job] = await jobs.list();
    expect(job).toMatchObject({ loaded: false, disabled: false });
  });

  it("runs in one queue with the job RPCs, so no jobs.json write is lost", async () => {
    seedOldJob();
    fake.delayMs = 2;
    const [result, created] = await Promise.all([adoptLaunchdJobs(jobs), jobs.create({ name: "Other", command: "true", schedule: { type: "interval", minutes: 5 }, path: "/bin" })]);
    expect(result.adopted).toHaveLength(1);
    const file = await jobs.readJobsFile();
    expect(file.names).toEqual({ [OLD_SLUG]: "PR review watch", [created]: "Other" });
    expect(file.adopted).toEqual({ [OLD_SLUG]: OLD_LABEL });
    // The create waited for the whole adoption: none of its launchctl calls come in between.
    const lastAdoption = fake.calls.findLastIndex((call) => call.join(" ").includes("pr-watch"));
    const firstCreate = fake.calls.findIndex((call) => call.join(" ").includes(`schedules.${created}`));
    expect(firstCreate).toBeGreaterThan(lastAdoption);
  });

  it("never writes over an adopted job or its backup when launchd-jobs makes the same job again", async () => {
    seedOldJob();
    await adoptLaunchdJobs(jobs);
    const firstPlist = readFileSync(jobs.plistPath(OLD_SLUG), "utf8");
    const firstBackup = join(env.dataDir, "adopted", `${OLD_LABEL}.plist`);
    const firstBackupText = readFileSync(firstBackup, "utf8");

    const { oldPlist } = seedOldJob();
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toEqual([{ from: OLD_LABEL, to: `${NEW_LABEL}-2` }]);
    expect(readFileSync(jobs.plistPath(OLD_SLUG), "utf8")).toBe(firstPlist);
    expect(readFileSync(firstBackup, "utf8")).toBe(firstBackupText);
    expect(existsSync(join(env.dataDir, "adopted", `${OLD_LABEL}-2.plist`))).toBe(true);
    expect(existsSync(oldPlist)).toBe(false);
    expect(fake.loaded.has(NEW_LABEL)).toBe(true);
    expect(fake.loaded.has(`${NEW_LABEL}-2`)).toBe(true);
  });

  it("keeps the new plist when neither the old plist nor its backup is left to restore", async () => {
    seedOldJob();
    fake.refuse.add(NEW_LABEL);
    const backup = join(env.dataDir, "adopted", `${OLD_LABEL}.plist`);
    fake.beforeCall = () => {
      if (fake.calls.at(-1)?.[0] === "bootstrap") rmSync(backup, { force: true });
    };
    expect((await adoptLaunchdJobs(jobs)).failed).toHaveLength(1);
    expect(existsSync(jobs.plistPath(OLD_SLUG))).toBe(true);
    expect(existsSync(jobs.adoptingNotePath(OLD_SLUG))).toBe(true);
  });

  it("puts the new plist out of LaunchAgents before the old one comes back", async () => {
    const { oldPlist } = seedOldJob();
    fake.refuse.add(NEW_LABEL);
    fake.refuseTimes.set(OLD_LABEL, 1);
    const both = neverBoth(oldPlist);
    expect((await adoptLaunchdJobs(jobs)).failed).toHaveLength(1);
    expect(both).toEqual([]);
    expect(fake.loaded.has(OLD_LABEL)).toBe(true);
    expect(existsSync(jobs.adoptingNotePath(OLD_SLUG))).toBe(false);
  });

  it("drops a leftover note for a finished move without touching launchd", async () => {
    seedOldJob();
    await adoptLaunchdJobs(jobs);
    writeFileSync(jobs.adoptingNotePath(OLD_SLUG), JSON.stringify({ from: OLD_LABEL, slug: OLD_SLUG, load: true, disable: false, backup: `${OLD_LABEL}.plist` }));
    const before = fake.calls.length;
    expect(await adoptLaunchdJobs(jobs)).toEqual({ adopted: [], skipped: [], failed: [] });
    expect(fake.calls.slice(before).map((call) => call[0])).not.toContain("bootout");
    expect(fake.calls.slice(before).map((call) => call[0])).not.toContain("bootstrap");
    expect(existsSync(jobs.adoptingNotePath(OLD_SLUG))).toBe(false);
    expect(fake.loaded.has(NEW_LABEL)).toBe(true);
  });

  it("leaves a running new job alone when finishing a move, and keeps the note", async () => {
    seedOldJob();
    fake.crashAfter = (args) => args[0] === "bootout" && args[1]!.endsWith(NEW_LABEL);
    void adoptLaunchdJobs(jobs);
    await vi.waitFor(() => expect(fake.calls.some((call) => call[0] === "bootout" && call[1]!.endsWith(NEW_LABEL))).toBe(true));
    fake.crashAfter = null;
    fake.loaded.set(NEW_LABEL, { path: jobs.plistPath(OLD_SLUG), running: true });
    const before = fake.calls.length;
    const result = await adoptLaunchdJobs(new LaunchdJobs(env));
    expect(result.skipped.map((entry) => entry.label)).toEqual([OLD_LABEL]);
    expect(fake.calls.slice(before).filter((call) => call[0] === "bootout" || call[0] === "bootstrap")).toEqual([]);
    expect(existsSync(jobs.adoptingNotePath(OLD_SLUG))).toBe(true);
  });

  it("doesn't bring back a job deleted while its move was unfinished", async () => {
    const { oldPlist } = seedOldJob();
    fake.crashAfter = (args) => args[0] === "bootout" && args[1]!.endsWith(NEW_LABEL);
    void adoptLaunchdJobs(jobs);
    await vi.waitFor(() => expect(fake.calls.some((call) => call[0] === "bootout" && call[1]!.endsWith(NEW_LABEL))).toBe(true));
    fake.crashAfter = null;
    const fresh = new LaunchdJobs(env);
    await fresh.remove(OLD_SLUG);
    expect(existsSync(fresh.adoptingNotePath(OLD_SLUG))).toBe(false);
    expect(await adoptLaunchdJobs(fresh)).toEqual({ adopted: [], skipped: [], failed: [] });
    expect(existsSync(oldPlist)).toBe(false);
    expect(existsSync(fresh.plistPath(OLD_SLUG))).toBe(false);
    expect(fake.loaded.size).toBe(0);
  });

  it("leaves a running job for a later start", async () => {
    const { oldPlist } = seedOldJob({ running: true });
    const result = await adoptLaunchdJobs(jobs);
    expect(result.skipped.map((entry) => entry.label)).toEqual([OLD_LABEL]);
    expect(fake.loaded.get(OLD_LABEL)?.running).toBe(true);
    expect(existsSync(oldPlist)).toBe(true);
    expect(fake.verbs()).not.toContain("bootout");
  });

  it("keeps a paused job paused", async () => {
    seedOldJob({ disabled: true });
    const result = await adoptLaunchdJobs(jobs);
    expect(result.adopted).toHaveLength(1);
    expect(fake.disabled.has("com.noahfidel.schedules.pr-watch")).toBe(true);
    expect(fake.loaded.has("com.noahfidel.schedules.pr-watch")).toBe(false);
    const [job] = await jobs.list();
    expect(job).toMatchObject({ disabled: true, loaded: false });
  });

  it("touches nothing when there are no launchd-jobs plists", async () => {
    mkdirSync(jobs.launchAgentsDir, { recursive: true });
    writeFileSync(join(jobs.launchAgentsDir, "com.example.other.plist"), renderPlist({ Label: "com.example.other" }));
    expect(await adoptLaunchdJobs(jobs)).toEqual({ adopted: [], skipped: [], failed: [] });
    expect(fake.calls).toEqual([]);
    expect(readdirSync(jobs.launchAgentsDir)).toEqual(["com.example.other.plist"]);
  });
});
