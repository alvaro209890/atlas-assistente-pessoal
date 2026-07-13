import { describe, expect, it, vi } from "vitest";

import { reconcileWhatsAppSessions, type WhatsAppSessionController } from "../src/session-sync.js";

function controller(initial: string[] = []): WhatsAppSessionController & {
  started: string[];
  stopped: string[];
} {
  const active = new Set(initial);
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    hasSession: (userId) => active.has(userId),
    listSessionUserIds: () => [...active],
    start: async (userId) => {
      active.add(userId);
      started.push(userId);
    },
    stop: async (userId) => {
      active.delete(userId);
      stopped.push(userId);
    },
  };
}

describe("reconcileWhatsAppSessions", () => {
  it("starts only active connection states and stops disconnected or deleted users", async () => {
    const sessions = controller(["disconnected-user", "deleted-user", "connected-user"]);
    await reconcileWhatsAppSessions(
      [
        { userId: "disconnected-user", connectionId: "c1", status: "disconnected" },
        { userId: "connected-user", connectionId: "c2", status: "connected" },
        { userId: "pairing-user", connectionId: "c3", status: "pairing" },
      ],
      sessions,
    );

    expect(sessions.stopped.sort()).toEqual(["deleted-user", "disconnected-user"]);
    expect(sessions.started).toEqual(["pairing-user"]);
  });

  it("reports start failures without aborting reconciliation", async () => {
    const onStartError = vi.fn();
    const sessions = controller();
    sessions.start = async () => {
      throw new Error("pairing failed");
    };
    await reconcileWhatsAppSessions(
      [{ userId: "user-1", connectionId: "c1", status: "pairing" }],
      sessions,
      onStartError,
    );
    expect(onStartError).toHaveBeenCalledWith("user-1", expect.any(Error));
  });
});
