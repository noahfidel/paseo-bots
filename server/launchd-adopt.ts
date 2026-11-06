// Adopts the jobs of the launchd-jobs plugin (@gpambrozio/paseo-launchd-jobs)
// into the Schedules screen: `com.paseo-plugins.launchd-jobs.<slug>` becomes
// `com.noahfidel.schedules.<slug>`, run by this plugin's runner, with its
// history, log and display name copied into this plugin's data folder.
//
// For each job: write the new plist, bootout the old label, copy the history
// (after the bootout, so no run lands in the old files meanwhile), bootstrap the
// new label, then move the old plist out of LaunchAgents into a backup folder.
// If the new label won't load, the new plist goes and the old job is loaded
// again. A job that is running right now waits for a later start. Running it
// again is safe: a job whose old plist is gone is done. Only plists under the
// launchd-jobs prefix are touched.

import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchdJobs } from "./launchd";
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

async function adoptOne(jobs: LaunchdJobs, oldLabel: string, result: AdoptResult): Promise<void> {
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
  const wasLoaded = printed !== null;
  const wasDisabled = (await jobs.readDisabled()).has(oldLabel);

  // A slug this label was already adopted under (an earlier start cut short), else its own, else a free one.
  const file = await jobs.readJobsFile();
  const taken = new Set(await jobs.listSlugs());
  let slug = Object.entries(file.adopted).find(([, label]) => label === oldLabel)?.[0];
  if (!slug) {
    slug = oldSlug;
    for (let n = 2; taken.has(slug); n += 1) slug = `${oldSlug}-${n}`;
  }
  const label = jobs.labelFor(slug);
  const newPlistPath = jobs.plistPath(slug);

  const runner = await jobs.ensureRunner();
  file.names[slug] = file.names[slug] ?? (await oldNames(oldDir))[oldSlug] ?? oldSlug;
  file.adopted[slug] = oldLabel;
  await jobs.writeJobsFile(file);
  await mkdir(jobs.launchAgentsDir, { recursive: true });
  await writeFile(newPlistPath, renderPlist(adoptedPlist(old, { label, slug, runner, oldDir, dataDir: env.dataDir, logPath: jobs.logPath(slug) })), "utf8");

  try {
    await jobs.bootoutIfLoaded(oldLabel);
    await mergeHistory(join(oldDir, "runs", `${oldSlug}.jsonl`), jobs.runsPath(slug));
    await copyIfMissing(join(oldDir, "logs", `${oldSlug}.log`), jobs.logPath(slug));
    await copyIfMissing(join(oldDir, "logs", `${oldSlug}.log.1`), `${jobs.logPath(slug)}.1`);
    await jobs.bootoutIfLoaded(label);
    if (wasDisabled) await jobs.launchctl(["disable", `${jobs.domain}/${label}`]);
    else await jobs.bootstrapPlist(newPlistPath);
  } catch (error) {
    // Put the old job back the way it was.
    await jobs.bootoutIfLoaded(label).catch(() => {});
    await rm(newPlistPath, { force: true });
    const latest = await jobs.readJobsFile();
    delete latest.adopted[slug];
    await jobs.writeJobsFile(latest);
    if (wasLoaded) {
      await jobs.bootstrapPlist(oldPlistPath).catch((restoreError: unknown) => console.error(`paseo-bots: couldn't load ${oldLabel} again after a failed move`, restoreError));
    }
    throw error;
  }

  const backupDir = join(env.dataDir, "adopted");
  await mkdir(backupDir, { recursive: true });
  await rename(oldPlistPath, join(backupDir, `${oldLabel}.plist`)).catch(async (error: unknown) => {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await copyFile(oldPlistPath, join(backupDir, `${oldLabel}.plist`));
    await rm(oldPlistPath, { force: true });
  });
  result.adopted.push({ from: oldLabel, to: label });
}

/** Adopts every launchd-jobs job it can; each failure is reported and leaves that job as it was. */
export async function adoptLaunchdJobs(jobs: LaunchdJobs): Promise<AdoptResult> {
  const result: AdoptResult = { adopted: [], skipped: [], failed: [] };
  if (!jobs.supported) return result;
  for (const oldLabel of await oldLabels(jobs)) {
    try {
      await adoptOne(jobs, oldLabel, result);
    } catch (error) {
      result.failed.push({ label: oldLabel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
