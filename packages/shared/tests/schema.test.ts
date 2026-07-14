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

  it("normaliza um reply needed:false com campos residuais para 'sem resposta'", () => {
    // O modelo às vezes devolve needed:false mas mantém objective/draft do enum.
    // Em vez de derrubar todo o triage, o schema reduz ao caso canônico.
    const parsed = aiDecisionSchema.parse({
      ...validDecision,
      reply: { ...validDecision.reply, needed: false },
    });
    expect(parsed.reply).toMatchObject({ needed: false, objective: "none", draft: null, tone: null });
  });

  it("normaliza um reply needed:true incompleto (sem draft) para 'sem resposta'", () => {
    const parsed = aiDecisionSchema.parse({
      ...validDecision,
      reply: { needed: true, objective: "answer", confidence: 0.4 },
    });
    expect(parsed.reply.needed).toBe(false);
  });

  it("preserva um reply needed:true bem formado", () => {
    const parsed = aiDecisionSchema.parse(validDecision);
    expect(parsed.reply).toMatchObject({ needed: true, objective: "acknowledge", draft: "Recebi. Envio amanhã." });
  });

  it("accepts a confidence-scored conversation classification", () => {
    const classified = {
      ...validDecision,
      conversationClassification: {
        groupId: "group-work",
        confidence: 0.91,
        reason: "As mensagens tratam de clientes e entregas.",
        evidenceMessageIds: ["msg-1"],
      },
    };
    expect(aiDecisionSchema.parse(classified).conversationClassification).toMatchObject({ groupId: "group-work", confidence: 0.91 });
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
