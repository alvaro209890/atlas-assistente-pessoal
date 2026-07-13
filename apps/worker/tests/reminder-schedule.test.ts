import { describe, expect, it } from "vitest";

import { materializeNextReminderOccurrence } from "../src/reminder-schedule.js";

describe("recurring reminder schedule", () => {
  it("materializes a stable next interval for replay idempotency", () => {
    const after = new Date("2026-07-13T12:00:00.000Z");
    const first = materializeNextReminderOccurrence({ intervalMinutes: 60 }, after, "America/Sao_Paulo");
    const replay = materializeNextReminderOccurrence({ intervalMinutes: 60 }, after, "America/Sao_Paulo");
    expect(first?.toISOString()).toBe("2026-07-13T13:00:00.000Z");
    expect(replay?.toISOString()).toBe(first?.toISOString());
  });

  it("keeps daily wall-clock time across daylight-saving timezone changes", () => {
    const after = new Date("2026-03-07T14:00:00.000Z");
    const next = materializeNextReminderOccurrence(
      { frequency: "daily", every: 1, time: "09:00" },
      after,
      "America/New_York",
    );
    expect(next?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("does not repeat a consumed nextAt without a recurrence rule", () => {
    expect(materializeNextReminderOccurrence(
      { nextAt: "2026-07-13T10:00:00.000Z" },
      new Date("2026-07-13T12:00:00.000Z"),
      "America/Sao_Paulo",
    )).toBeNull();
  });

  it("materializes common Portuguese recurrence rules and replays deterministically", () => {
    const after = new Date("2026-07-13T12:00:00.000Z");
    const friday = materializeNextReminderOccurrence({ rule: "toda sexta às 9" }, after, "America/Sao_Paulo");
    expect(friday?.toISOString()).toBe("2026-07-17T12:00:00.000Z");
    expect(materializeNextReminderOccurrence({ rule: "toda sexta às 9" }, after, "America/Sao_Paulo")?.toISOString()).toBe(friday?.toISOString());
    expect(materializeNextReminderOccurrence({ rule: "diariamente às 18" }, after, "America/Sao_Paulo")?.toISOString()).toBe("2026-07-13T21:00:00.000Z");
    expect(materializeNextReminderOccurrence({ rule: "a cada 2 horas" }, after, "America/Sao_Paulo")?.toISOString()).toBe("2026-07-13T14:00:00.000Z");
  });
});
