import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  run = async (args: string[]): Promise<CommandResult> => {
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

describe.skipIf(!onMac)("adopting launchd-jobs' jobs", () => {
  it("moves the job to our label, runner and folder, and backs up the old plist", async () => {
    const { oldPlist, other, otherText } = seedOldJob();
    const result = await adoptLaunchdJobs(jobs);
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
