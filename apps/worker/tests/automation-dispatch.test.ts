import { describe, expect, it } from "vitest";

import { composeAutomationNotification, isUserAutomationKind } from "../src/automation-dispatch.js";

describe("automation dispatch", () => {
  it.each([
    ["briefing", "Briefing do Atlas"],
    ["deadline", "Prazos próximos"],
    ["overdue", "Itens vencidos"],
    ["follow_up", "Follow-ups pendentes"],
    ["stale_task", "Tarefas paradas"],
    ["weekly_review", "Revisão semanal"],
  ] as const)("selects and composes %s", (kind, title) => {
    expect(isUserAutomationKind(kind)).toBe(true);
    expect(composeAutomationNotification(kind, ["Item real", "Item real"])).toEqual({
      title,
      body: "• Item real",
    });
  });
});
