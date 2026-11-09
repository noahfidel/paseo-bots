import { describe, expect, it, vi } from "vitest";
import { installChatOpens, chatOpenToRecord, publishChatOpen, MAX_CHAT_OPENS, type PaseoBotsChatOpens } from "../client/chat-opens";
import { OPEN_CHAT_SCREEN_ID } from "../client/open-chat";

const open = (n: number) => ({ serverId: "s", workspaceId: "w", agentId: `a${n}`, at: n });
const api = (target: Record<string, unknown>) => target.__paseoBotsChatOpens as PaseoBotsChatOpens;

describe("installChatOpens", () => {
  it("publishes a version 1 api with the pass-through screens", () => {
    const target: Record<string, unknown> = {};
    installChatOpens(target);
    expect(api(target).version).toBe(1);
    expect(api(target).passThroughScreens).toEqual([OPEN_CHAT_SCREEN_ID]);
    expect(api(target).recent()).toEqual([]);
  });

  it("returns the most recent first and keeps at most 20", () => {
    const target: Record<string, unknown> = {};
    installChatOpens(target);
    for (let n = 1; n <= 25; n++) publishChatOpen(open(n), target);
    const recent = api(target).recent();
    expect(MAX_CHAT_OPENS).toBe(20);
    expect(recent).toHaveLength(20);
    expect(recent[0].agentId).toBe("a25");
    expect(recent[19].agentId).toBe("a6");
  });

  it("returns a copy so callers cannot change the history", () => {
    const target: Record<string, unknown> = {};
    installChatOpens(target);
    publishChatOpen(open(1), target);
    api(target).recent().pop();
    expect(api(target).recent()).toHaveLength(1);
  });

  it("notifies subscribers after each open until they unsubscribe, and a throwing one starves nobody", () => {
    const target: Record<string, unknown> = {};
    installChatOpens(target);
    const seen: string[] = [];
    api(target).subscribe(() => {
      throw new Error("boom");
    });
    const off = api(target).subscribe((o) => seen.push(o.agentId));
    publishChatOpen(open(1), target);
    off();
    publishChatOpen(open(2), target);
    expect(seen).toEqual(["a1"]);
  });

  it("keeps history and listeners when the client re-runs", () => {
    const target: Record<string, unknown> = {};
    installChatOpens(target);
    const listener = vi.fn();
    api(target).subscribe(listener);
    publishChatOpen(open(1), target);
    const first = api(target);
    installChatOpens(target);
    expect(api(target)).toBe(first);
    expect(api(target).recent().map((o) => o.agentId)).toEqual(["a1"]);
    publishChatOpen(open(2), target);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("replaces an object of another version", () => {
    const target: Record<string, unknown> = { __paseoBotsChatOpens: { version: 99 } };
    installChatOpens(target);
    expect(api(target).version).toBe(1);
  });

  it("publishes even if the registry was not installed yet", () => {
    const target: Record<string, unknown> = {};
    publishChatOpen(open(1), target);
    expect(api(target).recent()).toHaveLength(1);
  });
});

describe("chatOpenToRecord", () => {
  const base = { serverId: "s", chatId: "c1", workspaceId: "w", now: 5 };
  it("records a real chat with its workspace", () => {
    expect(chatOpenToRecord(base)).toEqual({ serverId: "s", workspaceId: "w", agentId: "c1", at: 5 });
  });
  it("records nothing for the empty new-chat pane", () => {
    expect(chatOpenToRecord({ ...base, chatId: null })).toBeNull();
  });
  it("records nothing while the workspace is unknown", () => {
    expect(chatOpenToRecord({ ...base, workspaceId: undefined })).toBeNull();
    expect(chatOpenToRecord({ ...base, workspaceId: "" })).toBeNull();
  });
});
