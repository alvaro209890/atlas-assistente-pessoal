import type { Database } from "@atlas/database";
import { describe, expect, it, vi } from "vitest";

import { nextAutomationRun } from "../src/automation-schedule.js";
import { WorkerRepository } from "../src/repository.js";

describe("automation schedule materialization", () => {
  it("evaluates cron in the user's timezone", () => {
    expect(nextAutomationRun(
      "0 8 * * *",
      "America/Sao_Paulo",
      new Date("2026-07-13T10:00:00.000Z"),
    ).toISOString()).toBe("2026-07-13T11:00:00.000Z");
  });

  it("queues a due occurrence once and advances next_run_at", async () => {
    let jobAlreadyExists = false;
    const dueAt = new Date("2026-07-13T11:00:00.000Z");
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM automations") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return { rows: [{
          id: "automation-1", user_id: "user-1", kind: "briefing",
          schedule: "0 8 * * *", timezone: "America/Sao_Paulo", next_run_at: dueAt,
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO job_attempts")) {
        const inserted = !jobAlreadyExists;
        jobAlreadyExists = true;
        return { rows: [], rowCount: inserted ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const transaction = vi.fn(async (callback: (client: { query: typeof clientQuery }) => Promise<number>) => callback({ query: clientQuery }));
    const repository = new WorkerRepository({ transaction } as unknown as Database);

    await expect(repository.materializeDueAutomations(100, new Date("2026-07-13T12:00:00.000Z"))).resolves.toBe(1);
    await expect(repository.materializeDueAutomations(100, new Date("2026-07-13T12:00:00.000Z"))).resolves.toBe(0);

    const insert = clientQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO job_attempts"));
    expect(insert?.[1]).toEqual([
      "user-1",
      "automation:briefing",
      "schedule:automation-1:2026-07-13T11:00:00.000Z",
      JSON.stringify({ automationId: "automation-1", scheduledFor: "2026-07-13T11:00:00.000Z" }),
    ]);
    const advance = clientQuery.mock.calls.find((call) => String(call[0]).includes("UPDATE automations SET next_run_at") && !String(call[0]).includes("last_run_status='failed'"));
    expect((advance?.[1] as unknown[])[2]).toEqual(new Date("2026-07-14T11:00:00.000Z"));
  });
});
