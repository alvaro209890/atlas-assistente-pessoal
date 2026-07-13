import { describe, expect, it, vi } from "vitest";

import type { NormalizedMessage } from "@atlas/shared";

import { ConversationBatcher } from "../src/batcher.js";

const message = (id: string): NormalizedMessage => ({
  id,
  userId: "00000000-0000-0000-0000-000000000001",
  chatJid: "551199999999@s.whatsapp.net",
  senderJid: "551188888888@s.whatsapp.net",
  senderName: "Cliente",
  sentAt: `2026-07-13T15:00:0${id}Z`,
  fromMe: false,
  text: `mensagem ${id}`,
});

describe("ConversationBatcher", () => {
  it("flushes after 10 seconds of quiet", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new ConversationBatcher({
      onFlush: (batch) => void batches.push(batch.messages.map((item) => item.id)),
    });
    batcher.add(message("1"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([["1"]]);
    vi.useRealTimers();
  });

  it("resets quiet time but enforces the 30 second maximum", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new ConversationBatcher({
      onFlush: (batch) => void batches.push(batch.messages.map((item) => item.id)),
    });
    batcher.add(message("1"));
    await vi.advanceTimersByTimeAsync(9_000);
    batcher.add(message("2"));
    await vi.advanceTimersByTimeAsync(9_000);
    batcher.add(message("3"));
    await vi.advanceTimersByTimeAsync(9_000);
    batcher.add(message("4"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(batches).toEqual([["1", "2", "3", "4"]]);
    vi.useRealTimers();
  });

  it("can collect one sequence of up to 30 messages", async () => {
    vi.useFakeTimers();
    const sizes: number[] = [];
    const batcher = new ConversationBatcher({
      maxMessages: 30,
      onFlush: (batch) => void sizes.push(batch.messages.length),
    });
    for (let index = 0; index < 30; index += 1) batcher.add(message(String(index)));
    await vi.runAllTimersAsync();
    expect(sizes).toEqual([30]);
    vi.useRealTimers();
  });

  it("keeps a batch pending when persistence fails and retries without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    let attempts = 0;
    const batcher = new ConversationBatcher({
      onFlush: async (batch) => {
        attempts += 1;
        if (attempts === 1) throw new Error("database unavailable");
        batches.push(batch.messages.map((item) => item.id));
      },
    });

    batcher.add(message("1"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
    expect(batches).toEqual([["1"]]);
    vi.useRealTimers();
  });

  it("preserves messages that arrive while a flush is in progress", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    let releaseFirst: (() => void) | undefined;
    const firstFlush = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const batcher = new ConversationBatcher({
      onFlush: async (batch) => {
        batches.push(batch.messages.map((item) => item.id));
        if (batches.length === 1) await firstFlush;
      },
    });

    batcher.add(message("1"));
    await vi.advanceTimersByTimeAsync(10_000);
    batcher.add(message("2"));
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batches).toEqual([["1"], ["2"]]);
    vi.useRealTimers();
  });
});
