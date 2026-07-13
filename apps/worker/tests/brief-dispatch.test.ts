import { describe, expect, it, vi } from "vitest";

import { dispatchDueBriefs, QUEUES } from "../src/handlers.js";
import type { WorkerRepository } from "../src/repository.js";

describe("multi-tenant briefing dispatch", () => {
  it("continues with a connected user when another tenant loses its connection", async () => {
    const repository = {
      findDueBriefUsers: vi.fn(async () => [
        { userId: "user-disconnected", time: "08:00" },
        { userId: "user-connected", time: "08:00" },
      ]),
      buildBrief: vi.fn(async (userId: string) => `Briefing ${userId}`),
      shouldNotifySelf: vi.fn(async () => true),
      enqueueNotification: vi.fn(async (notification: { userId: string }) => {
        if (notification.userId === "user-disconnected") throw new Error("No WhatsApp connection");
        return 22;
      }),
    } as unknown as WorkerRepository;
    const boss = { send: vi.fn(async () => "job-1") };

    await expect(dispatchDueBriefs(
      boss as never,
      repository,
      new Date("2026-07-13T11:00:00.000Z"),
    )).resolves.toBe(1);
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(QUEUES.notification, { outboxId: 22, attempt: 0 });
    expect(repository.enqueueNotification).toHaveBeenCalledTimes(2);
  });
});
