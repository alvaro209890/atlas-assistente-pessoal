import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  makeTaskExecutionKey,
  type AiDecision,
  type AiTask,
} from "@atlas/shared";
import { describe, expect, it } from "vitest";

import { retargetFallbackEnrichment } from "../src/handlers.js";

const task: AiTask = {
  clientRef: "enriched-1", operation: "create", authorization: "inferred",
  authorizationMessageId: null, canonicalTaskId: null, candidateCardId: null,
  mergeSourceCardIds: [], title: "Enviar contrato", description: "Contrato revisado",
  priority: "high", targetListRole: "inbox", nextAction: "Revisar", waitingOn: null,
  risk: "low", checklist: [], dueAt: null, dueBasis: "none",
  labels: ["IA pendente", "Contrato"], labelsToRemove: [],
  memberIdsToAdd: [], memberIdsToRemove: [], project: null, person: null,
  estimateMinutes: null, recurrence: null, confidence: 0.95,
  evidenceMessageIds: ["message-1"], missingInformation: [],
};

const decision: AiDecision = {
  schemaVersion: AI_SCHEMA_VERSION,
  promptVersion: AI_PROMPT_VERSION,
  conversationIntent: "actionable",
  tasks: [task], reminders: [], commitments: [], learnings: [], actionProposals: [], memories: [],
  reply: { needed: false, recipientName: null, recipientJid: null, objective: "none", draft: null, tone: null, confidence: 1 },
  conversationSummary: "Contrato precisa ser enviado.",
  briefReason: "Tarefa explícita.",
};

describe("AI pending fallback enrichment", () => {
  it("retargets enrichment and replay to the same canonical task and card", () => {
    const target = { canonicalTaskId: "canonical-fallback-1", cardId: "card-fallback-1" };
    const first = retargetFallbackEnrichment(decision, target);
    const replay = retargetFallbackEnrichment(first, target);
    expect(replay).toEqual(first);
    expect(first.tasks[0]).toMatchObject({
      operation: "patch",
      canonicalTaskId: "canonical-fallback-1",
      candidateCardId: "card-fallback-1",
      labels: ["Contrato"],
      labelsToRemove: ["IA pendente"],
    });
    expect(makeTaskExecutionKey("batch-1", first.tasks[0]!.clientRef)).toBe(
      makeTaskExecutionKey("batch-1", replay.tasks[0]!.clientRef),
    );
  });

  it("keeps the stable canonical identity when the fallback card is not created yet", () => {
    const enriched = retargetFallbackEnrichment(decision, {
      canonicalTaskId: "canonical-fallback-1",
      cardId: null,
    });
    expect(enriched.tasks[0]).toMatchObject({
      operation: "create",
      canonicalTaskId: "canonical-fallback-1",
      candidateCardId: null,
    });
    expect(enriched.tasks[0]!.labels).not.toContain("IA pendente");
  });
});
