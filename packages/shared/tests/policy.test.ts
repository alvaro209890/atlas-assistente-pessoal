import { describe, expect, it } from "vitest";

import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  classifyTask,
  findInvalidDecisionReferences,
  type AiContext,
  type AiDecision,
  type AiTask,
} from "../src/index.js";

const task: AiTask = {
  clientRef: "a",
  operation: "create",
  authorization: "inferred",
  authorizationMessageId: null,
  canonicalTaskId: null,
  candidateCardId: null,
  mergeSourceCardIds: [],
  title: "Tarefa",
  description: "",
  priority: "normal",
  targetListRole: "inbox",
  nextAction: null,
  waitingOn: null,
  risk: "unknown",
  checklist: [],
  dueAt: null,
  dueBasis: "none",
  labels: [],
  labelsToRemove: [],
  memberIdsToAdd: [],
  memberIdsToRemove: [],
  project: null,
  person: null,
  estimateMinutes: null,
  recurrence: null,
  confidence: 0.7,
  evidenceMessageIds: ["m1"],
  missingInformation: [],
};

describe("task policy", () => {
  it("executes at the inclusive 0.70 threshold", () => {
    expect(classifyTask(task).disposition).toBe("execute");
  });

  it("routes lower confidence and missing data to review", () => {
    expect(classifyTask({ ...task, confidence: 0.699 }).disposition).toBe("review");
    expect(
      classifyTask({ ...task, missingInformation: ["prazo"] }).disposition,
    ).toBe("review");
  });

  it("never executes an explicit ignore", () => {
    expect(classifyTask({ ...task, operation: "ignore", confidence: 1 }).disposition).toBe(
      "ignore",
    );
  });

  it("does not turn group chatter assigned to someone else into the owner's task", () => {
    const context: AiContext = {
      now: "2026-07-14T15:00:00.000Z",
      chatJid: "team@g.us",
      chatName: "Equipe",
      previousSummary: null,
      preferences: { language: "pt-BR", timezone: "America/Sao_Paulo", replyTone: "direto", customInstructions: "", processOwnMessagesWithPrefix: "trello:" },
      messages: [{
        id: "m1", userId: "u1", chatJid: "team@g.us", senderJid: "manager", senderName: "Gestor",
        sentAt: "2026-07-14T15:00:00Z", fromMe: false, text: "Maria, envie o relatório", isGroup: true,
        mentionedJids: ["maria@s.whatsapp.net"], directedToUser: false,
      }],
      memories: [], corrections: [], activeLearnings: [], cardCandidates: [],
      allowedListKeys: ["inbox"], allowedTrelloMemberIds: [], isSelfChat: false,
      isGroupChat: true, ownerIdentity: { jids: ["owner@s.whatsapp.net"], names: ["Pessoa Usuária"] },
    };
    expect(classifyTask(task, 0.7, context)).toMatchObject({
      disposition: "ignore",
      reason: "group_message_not_directed_to_user",
    });
    context.messages[0] = { ...context.messages[0]!, directedToUser: true };
    expect(classifyTask(task, 0.7, context).disposition).toBe("execute");
  });

  it("rejects evidence and card IDs not supplied by context", () => {
    const decision: AiDecision = {
      schemaVersion: AI_SCHEMA_VERSION,
      promptVersion: AI_PROMPT_VERSION,
      conversationIntent: "actionable",
      tasks: [{ ...task, evidenceMessageIds: ["invented"], candidateCardId: null }],
      reminders: [],
      commitments: [],
      learnings: [],
      actionProposals: [],
      memories: [],
      reply: {
        needed: false,
        recipientName: null,
        recipientJid: null,
        objective: "none",
        draft: null,
        tone: null,
        confidence: 1,
      },
      conversationSummary: "Resumo",
      briefReason: "Pedido explícito",
    };
    const context: AiContext = {
      now: "2026-07-13T15:00:00.000Z",
      chatJid: "chat",
      chatName: null,
      previousSummary: null,
      preferences: {
        language: "pt-BR",
        timezone: "America/Sao_Paulo",
        replyTone: "direto",
        customInstructions: "",
        processOwnMessagesWithPrefix: "trello:",
      },
      messages: [],
      memories: [],
      corrections: [],
      activeLearnings: [],
      cardCandidates: [],
      allowedListKeys: ["inbox"],
      allowedTrelloMemberIds: [],
      isSelfChat: false,
    };
    expect(findInvalidDecisionReferences(decision, context)).toHaveLength(1);
  });

  it("requires confirmation for inferred destructive operations", () => {
    const destructive: AiTask = {
      ...task,
      operation: "complete",
      candidateCardId: "card-1",
    };
    expect(classifyTask(destructive).disposition).toBe("propose");

    const context: AiContext = {
      now: "2026-07-13T15:00:00.000Z",
      chatJid: "self",
      chatName: "Eu",
      previousSummary: null,
      preferences: { language: "pt-BR", timezone: "America/Sao_Paulo", replyTone: "direto", customInstructions: "", processOwnMessagesWithPrefix: "trello:" },
      messages: [{ id: "m1", userId: "u1", chatJid: "self", senderJid: "self", senderName: null, sentAt: "2026-07-13T15:00:00Z", fromMe: true, text: "feito card-1" }],
      memories: [],
      corrections: [],
      activeLearnings: [],
      cardCandidates: [{ id: "card-1", name: "Tarefa", description: "", listName: "Entrada", dueAt: null, url: null, canonicalTaskId: null }],
      allowedListKeys: ["done"],
      allowedTrelloMemberIds: [],
      isSelfChat: true,
    };
    expect(classifyTask({ ...destructive, authorization: "explicit_user_command", authorizationMessageId: "m1" }, 0.7, context).disposition).toBe("execute");
  });

  it("rejects invented member, proposal target and reminder task references", () => {
    const context: AiContext = {
      now: "2026-07-13T15:00:00.000Z", chatJid: "chat", chatName: null, previousSummary: null,
      preferences: { language: "pt-BR", timezone: "America/Sao_Paulo", replyTone: "direto", customInstructions: "", processOwnMessagesWithPrefix: "trello:" },
      messages: [{ id: "m1", userId: "u1", chatJid: "chat", senderJid: "contact", senderName: null, sentAt: "2026-07-13T15:00:00Z", fromMe: false, text: "pedido" }],
      memories: [], corrections: [], activeLearnings: [],
      cardCandidates: [{ id: "card-1", name: "Tarefa", description: "", listName: "Entrada", dueAt: null, url: null, canonicalTaskId: "task-1" }],
      allowedListKeys: ["inbox"], allowedTrelloMemberIds: ["member-allowed"], isSelfChat: false,
    };
    const invalid = {
      schemaVersion: AI_SCHEMA_VERSION, promptVersion: AI_PROMPT_VERSION, conversationIntent: "actionable" as const,
      tasks: [{ ...task, canonicalTaskId: "invented-canonical", memberIdsToAdd: ["member-invented"] }],
      reminders: [{ clientRef: "r1", taskClientRef: "missing-task-ref", title: "Lembrete", scheduledAt: "2026-07-14T12:00:00Z", recurrence: null, confidence: 1, evidenceMessageIds: ["m1"] }],
      commitments: [], learnings: [],
      actionProposals: [{ clientRef: "p1", kind: "profile_change" as const, title: "Mudar", targetIds: ["invented-target"], reversible: true, evidenceMessageIds: ["m1"], confidence: 1 }],
      memories: [],
      reply: { needed: false as const, recipientName: null, recipientJid: null, objective: "none" as const, draft: null, tone: null, confidence: 1 },
      conversationSummary: "Resumo", briefReason: "Validação",
    } satisfies AiDecision;
    expect(findInvalidDecisionReferences(invalid, context)).toEqual(expect.arrayContaining([
      expect.stringContaining("unknown Trello member"),
      expect.stringContaining("unknown canonical task"),
      expect.stringContaining("unknown task clientRef"),
      expect.stringContaining("unknown target"),
    ]));
  });
});
