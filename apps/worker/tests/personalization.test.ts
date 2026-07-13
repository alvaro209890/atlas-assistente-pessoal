import { describe, expect, it } from "vitest";

import { composeAtlasPersonalization } from "../src/personalization.js";

describe("Atlas personalization", () => {
  it("keeps different users isolated and never assumes a fixed name", () => {
    const ana = composeAtlasPersonalization({
      preferredName: "Ana", professionalArea: "Engenharia", goals: ["Entregar projeto"],
      workDays: [1, 2, 3, 4, 5], workStart: "08:00", workEnd: "17:00",
      communicationStyle: "concise", customInstructions: "Use frases curtas.",
    });
    const bruno = composeAtlasPersonalization({
      preferredName: "Bruno", professionalArea: "Direito", goals: ["Revisar contratos"],
      workDays: [1, 3, 5], workStart: "09:00", workEnd: "18:00",
      communicationStyle: "detailed", customInstructions: "",
    });
    expect(ana.customInstructions).toContain("Ana");
    expect(ana.customInstructions).not.toContain("Bruno");
    expect(bruno.customInstructions).toContain("Bruno");
    expect(bruno.customInstructions).not.toContain("Ana");
    expect(ana.replyTone).not.toBe(bruno.replyTone);
  });
});
