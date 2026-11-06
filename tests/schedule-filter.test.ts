import { describe, expect, it } from "vitest";
import { filterChoices, filterSchedules, parseScheduleFilter, resolveScheduleFilter, SCHEDULE_FILTER_EMPTY, type ScheduleItem, type ScheduleKind } from "../shared/schedules";

const item = (key: string, kind: ScheduleKind): ScheduleItem => ({
  key,
  kind,
  id: key,
  name: key,
  schedule: "",
  nextRunAt: null,
  paused: false,
  running: false,
  lastRun: null,
  failure: null,
});

const items = [item("r1", "routine"), item("r2", "routine"), item("l1", "launchd"), item("p1", "paseo"), item("p2", "paseo"), item("p3", "paseo")];

describe("schedule type filter", () => {
  it("All keeps every item; a kind keeps only that kind", () => {
    expect(filterSchedules(items, "all")).toEqual(items);
    expect(filterSchedules(items, "routine").map((i) => i.key)).toEqual(["r1", "r2"]);
    expect(filterSchedules(items, "launchd").map((i) => i.key)).toEqual(["l1"]);
    expect(filterSchedules(items, "paseo").map((i) => i.key)).toEqual(["p1", "p2", "p3"]);
  });

  it("counts items per kind", () => {
    const choices = filterChoices(items, true);
    expect(choices).toEqual([
      { value: "all", label: "All" },
      { value: "routine", label: "Bot routines (2)" },
      { value: "launchd", label: "launchd (1)" },
      { value: "paseo", label: "Paseo (3)" },
    ]);
    expect(filterChoices([], true).map((c) => c.label)).toEqual(["All", "Bot routines (0)", "launchd (0)", "Paseo (0)"]);
  });

  it("hides the launchd chip when launchd isn't shown", () => {
    expect(filterChoices(items, false).map((c) => c.value)).toEqual(["all", "routine", "paseo"]);
  });

  it("a saved launchd choice falls back to All when launchd isn't shown", () => {
    expect(resolveScheduleFilter("launchd", false)).toBe("all");
    expect(resolveScheduleFilter("launchd", true)).toBe("launchd");
    expect(resolveScheduleFilter("paseo", false)).toBe("paseo");
  });

  it("reads a saved choice, ignoring anything unknown", () => {
    expect(parseScheduleFilter("routine")).toBe("routine");
    expect(parseScheduleFilter("all")).toBe("all");
    expect(parseScheduleFilter("nope")).toBe("all");
    expect(parseScheduleFilter(null)).toBe("all");
  });

  it("has an empty-state line for every filter", () => {
    expect(SCHEDULE_FILTER_EMPTY).toEqual({
      all: "Nothing is scheduled yet.",
      routine: "No bot routines yet.",
      launchd: "No launchd jobs yet.",
      paseo: "No Paseo schedules yet.",
    });
  });
});
