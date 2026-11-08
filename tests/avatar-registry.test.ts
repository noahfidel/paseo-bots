import { afterEach, describe, expect, it, vi } from "vitest";
import { installAvatarRegistry, type PaseoBotsAvatars } from "../client/avatar-registry";
import type { BotSummary } from "../shared/bot-list";

const bot = (patch: Partial<BotSummary> = {}): BotSummary => ({
  id: "bot-1",
  name: "Inbox",
  title: "",
  archived: false,
  avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
  ...patch,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(fetch: () => Promise<BotSummary[]>, target: Record<string, unknown> = {}) {
  const focus = new Set<() => void>();
  const stop = installAvatarRegistry({
    fetch,
    target,
    intervalMs: 60_000,
    onFocus: (cb) => {
      focus.add(cb);
      return () => focus.delete(cb);
    },
  });
  return { target, stop, focus, api: () => target.__paseoBotsAvatars as PaseoBotsAvatars | undefined };
}

afterEach(() => vi.useRealTimers());

describe("installAvatarRegistry", () => {
  it("publishes a versioned api that returns null until the bots load", async () => {
    const { api } = setup(async () => [bot()]);
    expect(api()!.version).toBe(1);
    expect(api()!.get("bot-1", { dark: false })).toBeNull();
    await flush();
    expect(api()!.get("bot-1", { dark: false })).toMatchObject({ name: "Inbox" });
  });

  it("returns an svg for a generated avatar and null for an unknown bot", async () => {
    const { api } = setup(async () => [bot()]);
    await flush();
    const got = api()!.get("bot-1", { dark: true })!;
    expect(got.svg).toMatch(/^<svg /);
    expect(got.imageUrl).toBeUndefined();
    expect(api()!.get("nope", { dark: true })).toBeNull();
  });

  it("returns imageUrl instead of svg for an uploaded image, only when the url is safe", async () => {
    const { api } = setup(async () => [
      bot({ id: "a", avatar: { seed: "s", palette: null, shape: "circle", imageUrl: "data:image/webp;base64,AAAA" } }),
      bot({ id: "b", avatar: { seed: "s", palette: null, shape: "circle", imageUrl: "javascript:alert(1)" } }),
    ]);
    await flush();
    expect(api()!.get("a", { dark: false })).toEqual({ name: "Inbox", imageUrl: "data:image/webp;base64,AAAA" });
    const unsafe = api()!.get("b", { dark: false })!;
    expect(unsafe.imageUrl).toBeUndefined();
    expect(unsafe.svg).toMatch(/^<svg /);
  });

  it("still knows archived bots, so their old chats keep an avatar", async () => {
    const { api } = setup(async () => [bot({ archived: true })]);
    await flush();
    expect(api()!.get("bot-1", { dark: false })).not.toBeNull();
  });

  it("has nothing to draw when an older daemon sends no avatar", async () => {
    const { api } = setup(async () => [{ id: "bot-1", name: "Inbox", title: "", archived: false }]);
    await flush();
    expect(api()!.get("bot-1", { dark: false })).toBeNull();
  });

  it("notifies subscribers when something changed, not when a poll finds the same data", async () => {
    vi.useFakeTimers();
    let bots = [bot()];
    const { api } = setup(async () => bots);
    const listener = vi.fn();
    api()!.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    bots = [bot({ avatar: { seed: "changed", palette: null, shape: "circle", imageUrl: null } })];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).toHaveBeenCalledTimes(2);
    bots = [bot({ name: "Renamed" })];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("stops notifying an unsubscribed listener and survives a throwing one", async () => {
    vi.useFakeTimers();
    const { api } = setup(async () => [bot()]);
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const off = api()!.subscribe(bad);
    api()!.subscribe(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("refreshes on window focus", async () => {
    let bots = [bot()];
    const { api, focus } = setup(async () => bots);
    await flush();
    bots = [bot({ name: "Renamed" })];
    for (const cb of focus) cb();
    await flush();
    expect(api()!.get("bot-1", { dark: false })!.name).toBe("Renamed");
  });

  it("keeps the last data when a fetch fails", async () => {
    let fail = false;
    const { api, focus } = setup(async () => {
      if (fail) throw new Error("daemon not ready");
      return [bot()];
    });
    await flush();
    fail = true;
    for (const cb of focus) cb();
    await flush();
    expect(api()!.get("bot-1", { dark: false })).not.toBeNull();
  });

  it("cleanup removes the global, stops polling and unhooks focus", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => [bot()]);
    const { api, stop, focus, target } = setup(fetch);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(api()).toBeUndefined();
    expect(focus.size).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(target).not.toHaveProperty("__paseoBotsAvatars");
  });

  it("cleanup leaves a replacement registered by a newer run in place", async () => {
    const target: Record<string, unknown> = {};
    const first = setup(async () => [bot()], target);
    await flush();
    const second = setup(async () => [bot({ name: "Newer" })], target);
    await flush();
    first.stop();
    expect(second.api()!.get("bot-1", { dark: false })!.name).toBe("Newer");
    second.stop();
    expect(target).not.toHaveProperty("__paseoBotsAvatars");
  });

  it("re-registration replaces the old api and stops the old one's polling", async () => {
    vi.useFakeTimers();
    const target: Record<string, unknown> = {};
    const fetchOld = vi.fn(async () => [bot()]);
    setup(fetchOld, target);
    await vi.advanceTimersByTimeAsync(0);
    const old = target.__paseoBotsAvatars;
    const second = setup(async () => [bot()], target);
    expect(second.api()).not.toBe(old);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchOld).toHaveBeenCalledTimes(1);
  });
});
