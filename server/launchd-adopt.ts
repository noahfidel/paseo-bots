// Adopts the jobs of the launchd-jobs plugin (@gpambrozio/paseo-launchd-jobs)
// into the Schedules screen: `com.paseo-plugins.launchd-jobs.<slug>` becomes
// `com.noahfidel.schedules.<slug>`, run by this plugin's runner, with its
// history, log and display name copied into this plugin's data folder.
//
// Each job keeps the state it was in: loaded, unloaded or disabled. The steps,
// so that at no moment both plists sit in LaunchAgents (a login then would start
// both) and a cut-short move can be finished:
//
//   1. Stage: write the new plist and a "pending" note (slug, and whether the
//      job should end up loaded or disabled) to <dataDir>/adopting/.
//   2. Bootout the old label, copy its history (after the bootout, so no run
//      lands in the old files meanwhile), and move the old plist to
//      <dataDir>/adopted/ as the backup.
//   3. Move the new plist into LaunchAgents and bootstrap it (or disable it).
//   4. Drop the pending note.
//
// If a step fails, the old job is put back first: its plist returns from the
// backup and, if it was loaded, it's bootstrapped again (with retries, since
// launchd often refuses a label it just booted out). The pending note stays
// when that fails, so the next start still knows the job should run. After a
// crash the next start resumes from the note: an old plist still in place is
// adopted again with the state the note recorded; one already moved out is
// finished from step 3. A job that is running right now waits for a later
// start. Running it again is safe. Only plists under the launchd-jobs prefix
// are touched.

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic, type LaunchdJobs } from "./launchd";
import { DIR_VARIABLE, environmentOf, renderPlist, toPlistDict, type PlistDict } from "./launchd-plist";

export const OLD_PREFIX = "com.paseo-plugins.launchd-jobs.";
const OLD_DIR_VARIABLE = "PASEO_LAUNCHD_JOBS_DIR";

export interface AdoptResult {
  adopted: { from: string; to: string }[];
  skipped: { label: string; reason: string }[];
  failed: { label: string; error: string }[];
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function oldNames(oldDir: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse((await readText(join(oldDir, "jobs.json"))) ?? "{}") as { names?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.names ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** Old history first, then any lines the new file already has that the old one doesn't. */
async function mergeHistory(from: string, to: string): Promise<void> {
  const old = await readText(from);
  if (old === null) return;
  const current = (await readText(to)) ?? "";
  const oldLines = old.split("\n").filter((line) => line.trim() !== "");
  const seen = new Set(oldLines);
  const extra = current.split("\n").filter((line) => line.trim() !== "" && !seen.has(line));
  await writeFile(to, [...oldLines, ...extra].map((line) => `${line}\n`).join(""), "utf8");
}

async function copyIfMissing(from: string, to: string): Promise<void> {
  if ((await readText(to)) !== null) return;
  try {
    await copyFile(from, to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function oldLabels(jobs: LaunchdJobs): Promise<string[]> {
  try {
    return (await readdir(jobs.launchAgentsDir))
      .filter((name) => name.startsWith(OLD_PREFIX) && name.endsWith(".plist"))
      .map((name) => name.slice(0, -".plist".length))
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** The old plist rewritten for this plugin: new label, our runner and folder, its schedule and other keys kept. */
export function adoptedPlist(old: Record<string, unknown>, input: { label: string; slug: string; runner: string; oldDir: string; dataDir: string; logPath: string }): PlistDict {
  const plist = toPlistDict(old);
  plist.Label = input.label;
  const args = Array.isArray(old.ProgramArguments) ? old.ProgramArguments : [];
  const managed = args.length === 4 && args[0] === "/bin/zsh" && typeof args[1] === "string" && args[1].endsWith("/runner.sh") && typeof args[3] === "string";
  if (managed) plist.ProgramArguments = ["/bin/zsh", input.runner, input.slug, args[3] as string];
  const env: PlistDict = { ...environmentOf(old) };
  delete env[OLD_DIR_VARIABLE];
  env[DIR_VARIABLE] = input.dataDir;
  plist.EnvironmentVariables = env;
  for (const key of ["StandardErrorPath", "StandardOutPath"]) {
    const value = plist[key];
    if (key === "StandardErrorPath" && managed) plist[key] = input.logPath;
    else if (typeof value === "string" && value.startsWith(`${input.oldDir}/`)) plist[key] = input.logPath;
  }
  return plist;
}

/** An adoption in progress: kept in <dataDir>/adopting/<slug>.json until the move is done. */
interface Pending {
  from: string;
  slug: string;
  /** Whether the job should end up loaded: it was loaded (and not disabled) when the move began. */
  load: boolean;
  disable: boolean;
  /** The old plist's backup, a file name in <dataDir>/adopted/; never one an earlier adoption wrote. */
  backup: string;
}

/** Thrown where a job is running right now: it's left alone, with its note, for a later start. */
class RunningNow extends Error {}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** rename, or copy and delete across volumes. */
async function move(from: string, to: string): Promise<void> {
  await rename(from, to).catch(async (error: unknown) => {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  });
}

class Paths {
  constructor(
    private readonly jobs: LaunchdJobs,
    readonly from: string,
    readonly slug: string,
    private readonly backupName: string,
  ) {}
  get label(): string {
    return this.jobs.labelFor(this.slug);
  }
  get oldPlist(): string {
    return join(this.jobs.launchAgentsDir, `${this.from}.plist`);
  }
  get newPlist(): string {
    return this.jobs.plistPath(this.slug);
  }
  get staged(): string {
    return this.jobs.adoptingPlistPath(this.slug);
  }
  get note(): string {
    return this.jobs.adoptingNotePath(this.slug);
  }
  get backup(): string {
    return join(backupDir(this.jobs), this.backupName);
  }
}

function pendingDir(jobs: LaunchdJobs): string {
  return jobs.adoptingDir;
}

function backupDir(jobs: LaunchdJobs): string {
  return join(jobs.env.dataDir, "adopted");
}

/** `<label>.plist`, or `<label>-2.plist`... when an earlier adoption's backup has that name. */
async function freeBackupName(jobs: LaunchdJobs, oldLabel: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${oldLabel}.plist` : `${oldLabel}-${n}.plist`;
    if (!(await exists(join(backupDir(jobs), name)))) return name;
  }
}

async function isRunning(jobs: LaunchdJobs, label: string): Promise<boolean> {
  const printed = await jobs.printService(label);
  return printed !== null && /^\s*state = running/m.test(printed);
}

async function readPendings(jobs: LaunchdJobs): Promise<Pending[]> {
  let names: string[];
  try {
    names = await readdir(pendingDir(jobs));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const pendings: Pending[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const note = JSON.parse((await readText(join(pendingDir(jobs), name))) ?? "") as Partial<Pending>;
      if (typeof note.from === "string" && typeof note.slug === "string" && note.from.startsWith(OLD_PREFIX)) {
        const backup = typeof note.backup === "string" && /^[^/]+\.plist$/.test(note.backup) ? note.backup : `${note.from}.plist`;
        pendings.push({ from: note.from, slug: note.slug, load: note.load === true, disable: note.disable === true, backup });
      }
    } catch (error) {
      console.warn(`paseo-bots: ignoring the unreadable adoption note ${name}: ${String(error)}`);
    }
  }
  return pendings;
}

async function setAdopted(jobs: LaunchdJobs, slug: string, from: string | null, name?: string): Promise<void> {
  const file = await jobs.readJobsFile();
  if (from === null) delete file.adopted[slug];
  else file.adopted[slug] = from;
  if (name !== undefined) file.names[slug] = file.names[slug] ?? name;
  await jobs.writeJobsFile(file);
}

/**
 * Puts the old job back as it was. The new plist leaves LaunchAgents first (back
 * to the staging folder), so the two are never there together; then the old
 * plist returns from its backup and, when the job should run, is loaded again.
 * If the old plist can't come back (or neither it nor its backup exists), the
 * new plist goes back in: the only copy of a job is never deleted. The note is
 * dropped only once the old job is fully back, so a later start still knows
 * what the job should be.
 */
async function restoreOld(jobs: LaunchdJobs, paths: Paths, pending: Pending): Promise<void> {
  const log = (what: string) => (error: unknown) => console.error(`paseo-bots: ${what} after a failed move of ${pending.from}:`, error);
  try {
    if (await isRunning(jobs, paths.label)) {
      console.warn(`paseo-bots: ${paths.label} is running; the move of ${pending.from} is finished on a later start.`);
      return;
    }
    await jobs.bootoutIfLoaded(paths.label);
    if (await exists(paths.newPlist)) await move(paths.newPlist, paths.staged);
  } catch (error) {
    log("couldn't take the new job out")(error);
    return;
  }
  try {
    if (!(await exists(paths.oldPlist))) {
      if (!(await exists(paths.backup))) throw new Error(`Neither ${paths.oldPlist} nor its backup ${paths.backup} is there.`);
      await move(paths.backup, paths.oldPlist);
    }
  } catch (error) {
    log("couldn't put the old plist back")(error);
    if (await exists(paths.staged).catch(() => false)) await move(paths.staged, paths.newPlist).catch(log("couldn't put the new plist back either"));
    return;
  }
  if (pending.load) {
    try {
      if ((await jobs.printService(pending.from)) === null) await jobs.bootstrapWithRetry(paths.oldPlist);
    } catch (error) {
      // The old plist is in LaunchAgents, so it loads at login; the note keeps "should run" for the next start.
      log("couldn't load the old job again")(error);
      return;
    }
  }
  await rm(paths.staged, { force: true }).catch(() => {});
  await rm(paths.note, { force: true }).catch(() => {});
  await setAdopted(jobs, pending.slug, null).catch(() => {});
}

/** Step 3: the new plist into LaunchAgents, then loaded, disabled or left as it is. A running job is never touched. */
async function placeNew(jobs: LaunchdJobs, paths: Paths, pending: Pending): Promise<void> {
  if (await isRunning(jobs, paths.label)) throw new RunningNow(`${paths.label} is running now; the move finishes on a later start.`);
  if (await exists(paths.staged)) await move(paths.staged, paths.newPlist);
  else if (!(await exists(paths.newPlist))) throw new Error(`The new plist for ${pending.from} is missing.`);
  await jobs.bootoutIfLoaded(paths.label);
  if (pending.disable) await jobs.launchctl(["disable", `${jobs.domain}/${paths.label}`]);
  else if (pending.load) await jobs.bootstrapWithRetry(paths.newPlist);
}

/** The move is done; a leftover note only costs a no-op next time. */
async function done(paths: Paths, pending: Pending, result: AdoptResult): Promise<void> {
  await rm(paths.note, { force: true }).catch((error: unknown) => console.warn(`paseo-bots: moved ${pending.from}, but couldn't remove its adoption note: ${String(error)}`));
  result.adopted.push({ from: pending.from, to: paths.label });
}

async function adoptOne(jobs: LaunchdJobs, oldLabel: string, earlier: Pending | undefined, pendings: Pending[], result: AdoptResult): Promise<void> {
  const env = jobs.env;
  const oldSlug = oldLabel.slice(OLD_PREFIX.length);
  const oldPlistPath = join(jobs.launchAgentsDir, `${oldLabel}.plist`);
  const old = await env.readPlist(oldPlistPath);
  const oldDir = environmentOf(old)[OLD_DIR_VARIABLE] ?? join(env.paseoHome, "plugin-data", "launchd-jobs");

  const printed = await jobs.printService(oldLabel);
  if (printed !== null && /^\s*state = running/m.test(printed)) {
    result.skipped.push({ label: oldLabel, reason: "It's running now; it moves on a later start." });
    return;
  }
  const disabled = (await jobs.readDisabled()).has(oldLabel);
  // Keep the state it's in. After a start cut short (the old job booted out, its
  // plist still here), the note says what that state was.
  const load = !disabled && (printed !== null || earlier?.load === true);

  // The slug of an earlier, cut-short adoption of this label, else its own,
  // else a free one: a job already in LaunchAgents (or staged by another
  // adoption) is never written over, even one adopted from this same label.
  let slug = earlier?.slug;
  if (!slug) {
    const taken = new Set([...(await jobs.listSlugs()), ...pendings.map((entry) => entry.slug)]);
    slug = oldSlug;
    for (let n = 2; taken.has(slug); n += 1) slug = `${oldSlug}-${n}`;
  }
  const backup = earlier?.backup ?? (await freeBackupName(jobs, oldLabel));
  const paths = new Paths(jobs, oldLabel, slug, backup);
  const pending: Pending = { from: oldLabel, slug, load, disable: disabled, backup };

  // 1. Stage.
  const runner = await jobs.ensureRunner();
  await mkdir(pendingDir(jobs), { recursive: true });
  await writeAtomic(paths.staged, renderPlist(adoptedPlist(old, { label: paths.label, slug, runner, oldDir, dataDir: env.dataDir, logPath: jobs.logPath(slug) })));
  await writeAtomic(paths.note, `${JSON.stringify(pending, null, 2)}\n`);
  await setAdopted(jobs, slug, oldLabel, (await oldNames(oldDir))[oldSlug] ?? oldSlug);

  try {
    // 2. Old job out, history over, old plist to the backup.
    await jobs.bootoutIfLoaded(oldLabel);
    await mergeHistory(join(oldDir, "runs", `${oldSlug}.jsonl`), jobs.runsPath(slug));
    await copyIfMissing(join(oldDir, "logs", `${oldSlug}.log`), jobs.logPath(slug));
    await copyIfMissing(join(oldDir, "logs", `${oldSlug}.log.1`), `${jobs.logPath(slug)}.1`);
    await mkdir(backupDir(jobs), { recursive: true });
    if (await exists(paths.backup)) throw new Error(`${paths.backup} already exists.`);
    await move(oldPlistPath, paths.backup);
    // 3. New job in.
    await mkdir(jobs.launchAgentsDir, { recursive: true });
    await placeNew(jobs, paths, pending);
  } catch (error) {
    if (error instanceof RunningNow) {
      result.skipped.push({ label: oldLabel, reason: error.message });
      return;
    }
    await restoreOld(jobs, paths, pending);
    throw error;
  }
  await done(paths, pending, result);
}

/**
 * A move cut short after the old plist left LaunchAgents. With the new plist
 * already in place, only what's missing is done (load or disable it), and
 * nothing when it's already right; else step 3 runs again. A job running now
 * is left for a later start.
 */
async function finishOne(jobs: LaunchdJobs, pending: Pending, result: AdoptResult): Promise<void> {
  const paths = new Paths(jobs, pending.from, pending.slug, pending.backup);
  if (await isRunning(jobs, paths.label)) {
    result.skipped.push({ label: pending.from, reason: `${paths.label} is running now; the move finishes on a later start.` });
    return;
  }
  if (!(await exists(paths.staged)) && (await exists(paths.newPlist))) {
    const loaded = (await jobs.printService(paths.label)) !== null;
    const disabled = (await jobs.readDisabled()).has(paths.label);
    if (pending.disable && !disabled) await jobs.launchctl(["disable", `${jobs.domain}/${paths.label}`]);
    else if (pending.load && !pending.disable && !loaded) await jobs.bootstrapWithRetry(paths.newPlist);
    else {
      await rm(paths.note, { force: true });
      return;
    }
    await done(paths, pending, result);
    return;
  }
  try {
    await placeNew(jobs, paths, pending);
  } catch (error) {
    if (error instanceof RunningNow) {
      result.skipped.push({ label: pending.from, reason: error.message });
      return;
    }
    await restoreOld(jobs, paths, pending);
    throw error;
  }
  await done(paths, pending, result);
}

/**
 * Adopts every launchd-jobs job it can; each failure is reported and leaves
 * that job as it was. Runs in the jobs queue, so no RPC writes jobs.json meanwhile.
 */
export function adoptLaunchdJobs(jobs: LaunchdJobs): Promise<AdoptResult> {
  return jobs.exclusive(async () => {
    const result: AdoptResult = { adopted: [], skipped: [], failed: [] };
    if (!jobs.supported) return result;
    const labels = await oldLabels(jobs);
    const pendings = await readPendings(jobs);
    const fail = (label: string, error: unknown) => result.failed.push({ label, error: error instanceof Error ? error.message : String(error) });
    for (const pending of pendings) {
      if (labels.includes(pending.from)) continue;
      await finishOne(jobs, pending, result).catch((error: unknown) => fail(pending.from, error));
    }
    for (const oldLabel of labels) {
      await adoptOne(
        jobs,
        oldLabel,
        pendings.find((pending) => pending.from === oldLabel),
        pendings,
        result,
      ).catch((error: unknown) => fail(oldLabel, error));
    }
    return result;
  });
}
