import { describe, expect, it } from "vitest";

import { doubtDedupeKey, withinSocialHours } from "../src/self-improve.js";

describe("withinSocialHours", () => {
  it("permite perguntas durante o dia no fuso do usuário", () => {
    // 15:00 UTC = 12:00 em America/Sao_Paulo (UTC-3).
    const midday = new Date("2026-07-14T15:00:00Z");
    expect(withinSocialHours("America/Sao_Paulo", midday)).toBe(true);
  });

  it("bloqueia perguntas de madrugada no fuso do usuário", () => {
    // 06:00 UTC = 03:00 em America/Sao_Paulo.
    const dawn = new Date("2026-07-14T06:00:00Z");
    expect(withinSocialHours("America/Sao_Paulo", dawn)).toBe(false);
  });

  it("usa UTC como aproximação quando o fuso é inválido", () => {
    const noonUtc = new Date("2026-07-14T12:00:00Z");
    expect(withinSocialHours("Fuso/Inexistente", noonUtc)).toBe(true);
    expect(withinSocialHours("Fuso/Inexistente", new Date("2026-07-14T02:00:00Z"))).toBe(false);
  });
});

describe("doubtDedupeKey", () => {
  it("é estável para a mesma dúvida e distinto entre dúvidas", () => {
    const first = doubtDedupeKey({ key: "task:1", question: "a" });
    const again = doubtDedupeKey({ key: "task:1", question: "texto diferente, mesma dúvida" });
    const other = doubtDedupeKey({ key: "task:2", question: "a" });
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first.startsWith("proactive-question:")).toBe(true);
  });
});
