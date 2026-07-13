import { describe, expect, it } from "vitest";

import {
  consolidateCatchUpTitles,
  aiCommitmentSchema,
  buildAiContext,
  canExecuteCommitmentMutation,
  defaultReminderOffsetsMinutes,
  isInferredLearningStale,
  isWithinQuietHours,
  makeCanonicalTaskFingerprint,
  parseAtlasSelfCommand,
  scoreAtlasSelfCommands,
  shouldActivateLearning,
} from "../src/index.js";

describe("Atlas self commands", () => {
  it.each([
    ["feito orçamento", "complete"],
    ["adiar 1h contrato", "snooze"],
    ["amanhã às 9 reunião", "reschedule"],
    ["silenciar tarefa 42", "silence"],
    ["abrir orçamento", "open"],
    ["por quê tarefa urgente?", "explain"],
  ])("parses %s", (input, kind) => {
    expect(parseAtlasSelfCommand(input)?.kind).toBe(kind);
  });

  it("does not treat ordinary conversation as a command", () => {
    expect(parseAtlasSelfCommand("Bom dia, tudo bem?")).toBeNull();
  });

  it("resolves at least 95% of the unequivocal self-command corpus", () => {
    const score = scoreAtlasSelfCommands();
    expect(score.total).toBeGreaterThanOrEqual(20);
    expect(score.resolutionRate).toBeGreaterThanOrEqual(0.95);
    expect(score.passed).toBe(true);
  });
});

describe("task and reminder policies", () => {
  it("deduplicates equivalent task language across batches and users independently", () => {
    const first = makeCanonicalTaskFingerprint({ userId: "u1", title: "Enviar orçamento", project: "Cliente Árvore", nextAction: "Revisar valores" });
    const second = makeCanonicalTaskFingerprint({ userId: "u1", title: "  ENVIAR ORCAMENTO! ", project: "cliente arvore", nextAction: "revisar valores" });
    expect(second).toBe(first);
    expect(makeCanonicalTaskFingerprint({ userId: "u2", title: "Enviar orçamento", project: "Cliente Árvore", nextAction: "Revisar valores" })).not.toBe(first);
  });

  it("uses 24h plus 2h for urgent work and respects overnight quiet hours", () => {
    expect(defaultReminderOffsetsMinutes("urgent")).toEqual([1440, 120]);
    expect(defaultReminderOffsetsMinutes("normal")).toEqual([120]);
    expect(isWithinQuietHours("22:15", { start: "21:00", end: "07:00" })).toBe(true);
    expect(isWithinQuietHours("06:59", { start: "21:00", end: "07:00" })).toBe(true);
    expect(isWithinQuietHours("07:00", { start: "21:00", end: "07:00" })).toBe(false);
    expect(consolidateCatchUpTitles(["A", "A", "B"])).toBe("• A\n• B");
  });
});

describe("commitment lifecycle", () => {
  const base = {
    clientRef: "c1", direction: "owed_to_me" as const, title: "João deve pagar",
    counterparty: "João", dueAt: null, nextFollowUpAt: null, confidence: 0.95,
    evidenceMessageIds: ["m1"],
  };

  it("requires a tenant-provided candidate id for lifecycle updates", () => {
    expect(aiCommitmentSchema.safeParse({ ...base, operation: "create", commitmentId: null }).success).toBe(true);
    expect(aiCommitmentSchema.safeParse({ ...base, operation: "fulfill", commitmentId: null }).success).toBe(false);
    expect(aiCommitmentSchema.safeParse({ ...base, operation: "fulfill", commitmentId: "commitment-1" }).success).toBe(true);
  });

  it("turns third-party completion claims into confirmation proposals", () => {
    const commitment = aiCommitmentSchema.parse({
      ...base, operation: "fulfill", commitmentId: "commitment-1",
      authorization: "inferred", authorizationMessageId: null,
    });
    const context = buildAiContext({
      now: new Date("2026-07-13T12:00:00Z"), chatJid: "cliente@s.whatsapp.net",
      messages: [{ id: "m1", userId: "u1", chatJid: "cliente@s.whatsapp.net", senderJid: "cliente@s.whatsapp.net", senderName: "João", sentAt: "2026-07-13T12:00:00Z", fromMe: false, text: "já paguei" }],
      isSelfChat: false,
    });
    expect(canExecuteCommitmentMutation(commitment, context)).toBe(false);
  });
});

describe("learning promotion", () => {
  const evidence = [
    { id: "1", occurredAt: "2026-07-10T12:00:00Z", confidence: 0.9 },
    { id: "2", occurredAt: "2026-07-10T18:00:00Z", confidence: 0.92 },
    { id: "3", occurredAt: "2026-07-11T12:00:00Z", confidence: 0.95 },
  ];

  it("activates explicit instructions immediately and inferred low-risk rules only after repeated evidence", () => {
    expect(shouldActivateLearning({ explicitInstruction: true, risk: "high", confidence: 0.2, evidence: [] })).toBe(true);
    expect(shouldActivateLearning({ explicitInstruction: false, risk: "low", confidence: 0.9, evidence })).toBe(true);
    expect(shouldActivateLearning({ explicitInstruction: false, risk: "high", confidence: 0.99, evidence })).toBe(false);
    expect(shouldActivateLearning({ explicitInstruction: false, risk: "low", confidence: 0.9, evidence: evidence.slice(0, 2) })).toBe(false);
  });

  it("marks an inferred preference stale after 90 days", () => {
    expect(isInferredLearningStale("2026-04-01T00:00:00Z", new Date("2026-07-13T00:00:00Z"))).toBe(true);
  });
});
