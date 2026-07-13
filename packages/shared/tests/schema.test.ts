import { describe, expect, it } from "vitest";

import {
  aiCorrectionSchema,
  aiDecisionSchema,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
} from "../src/index.js";

const validDecision = {
  schemaVersion: AI_SCHEMA_VERSION,
  promptVersion: AI_PROMPT_VERSION,
  conversationIntent: "actionable",
  tasks: [
    {
      clientRef: "task-1",
      operation: "create",
      authorization: "inferred",
      authorizationMessageId: null,
      canonicalTaskId: null,
      candidateCardId: null,
      mergeSourceCardIds: [],
      title: "Enviar orçamento",
      description: "Enviar a versão revisada.",
      priority: "high",
      targetListRole: "inbox",
      nextAction: "Revisar os valores",
      waitingOn: null,
      risk: "medium",
      checklist: [{ text: "Conferir valores", done: false }],
      dueAt: "2026-07-14T17:00:00-03:00",
      dueBasis: "explicit_relative",
      labelsToRemove: [],
      project: null,
      person: null,
      estimateMinutes: 30,
      recurrence: null,
      labels: ["orçamento"],
      confidence: 0.91,
      evidenceMessageIds: ["msg-1"],
      missingInformation: [],
    },
  ],
  reminders: [],
  commitments: [],
  learnings: [],
  actionProposals: [],
  memories: [
    {
      operation: "upsert",
      nodeType: "person",
      title: "João",
      generatedContent: "Prefere respostas curtas.",
      aliases: ["João do orçamento"],
      tags: ["cliente"],
      confidence: 0.8,
      sourceMessageIds: ["msg-1"],
      relations: [],
      expiresAt: null,
    },
  ],
  reply: {
    needed: true,
    recipientName: "João",
    recipientJid: "551199999999@s.whatsapp.net",
    objective: "acknowledge",
    draft: "Recebi. Envio amanhã.",
    tone: "direto",
    confidence: 0.9,
  },
  conversationSummary: "João pediu um orçamento revisado para amanhã.",
  briefReason: "Existe um pedido explícito com prazo.",
} as const;

describe("aiDecisionSchema", () => {
  it("accepts a complete tasks, memories and reply decision", () => {
    expect(aiDecisionSchema.parse(validDecision).tasks).toHaveLength(1);
  });

  it("rejects a patch without a candidate card", () => {
    const invalid = structuredClone(validDecision);
    invalid.tasks[0].operation = "patch";
    expect(aiDecisionSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a reply with needed false and a draft", () => {
    const invalid = { ...validDecision, reply: { ...validDecision.reply, needed: false } };
    expect(aiDecisionSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("aiCorrectionSchema", () => {
  it("accepts feedback action, comment and metadata for future prompts", () => {
    expect(
      aiCorrectionSchema.parse({
        action: "merge",
        comment: "Mesclar com o projeto existente",
        metadata: { targetNodeId: "node-1" },
        createdAt: "2026-07-13T15:00:00Z",
      }),
    ).toMatchObject({ action: "merge", metadata: { targetNodeId: "node-1" } });
  });
});
