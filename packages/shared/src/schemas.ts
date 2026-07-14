import { z } from "zod";

import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from "./constants.js";

const nullableTrimmedText = (max: number) =>
  z.string().trim().min(1).max(max).nullable();

export const taskOperationSchema = z.enum([
  "create",
  "patch",
  "comment",
  "complete",
  "reopen",
  "cancel",
  "merge",
  "ignore",
]);

export const taskAuthorizationSchema = z.enum([
  "inferred",
  "explicit_user_command",
  "confirmed_proposal",
]);

export const taskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const dueBasisSchema = z.enum([
  "explicit",
  "explicit_relative",
  "inferred",
  "none",
]);

export const targetListRoleSchema = z.enum(["inbox", "inProgress", "paused", "done"]);
export const taskRiskSchema = z.enum(["low", "medium", "high", "critical", "unknown"]);

export const checklistItemSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    done: z.boolean().default(false),
  })
  .strict();

export const aiTaskSchema = z
  .object({
    clientRef: z.string().trim().min(1).max(80),
    operation: taskOperationSchema,
    authorization: taskAuthorizationSchema.default("inferred"),
    authorizationMessageId: nullableTrimmedText(256).default(null),
    canonicalTaskId: nullableTrimmedText(128).default(null),
    candidateCardId: nullableTrimmedText(128),
    mergeSourceCardIds: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    title: z.string().trim().min(1).max(180),
    description: z.string().trim().max(8_000).default(""),
    priority: taskPrioritySchema,
    targetListRole: targetListRoleSchema,
    nextAction: nullableTrimmedText(500),
    waitingOn: nullableTrimmedText(300),
    risk: taskRiskSchema,
    checklist: z.array(checklistItemSchema).max(30),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    dueBasis: dueBasisSchema,
    labels: z.array(z.string().trim().min(1).max(80)).max(12),
    labelsToRemove: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    memberIdsToAdd: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    memberIdsToRemove: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    project: nullableTrimmedText(240).default(null),
    person: nullableTrimmedText(240).default(null),
    estimateMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    recurrence: nullableTrimmedText(300).default(null),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
    missingInformation: z.array(z.string().trim().min(1).max(300)).max(12),
  })
  .strict()
  .superRefine((task, ctx) => {
    const needsExistingCard = ["patch", "comment", "complete", "reopen", "cancel", "merge"].includes(task.operation);
    if (needsExistingCard && task.candidateCardId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateCardId"],
        message: `${task.operation} requires candidateCardId`,
      });
    }

    if (task.operation === "merge" && task.mergeSourceCardIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mergeSourceCardIds"],
        message: "merge requires at least one source card",
      });
    }

    if (task.operation !== "merge" && task.mergeSourceCardIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mergeSourceCardIds"],
        message: "mergeSourceCardIds is only valid for merge",
      });
    }

    const memberRemovals = new Set(task.memberIdsToRemove);
    if (task.memberIdsToAdd.some((id) => memberRemovals.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["memberIdsToAdd"],
        message: "the same Trello member cannot be added and removed",
      });
    }

    if (
      task.authorization !== "inferred" &&
      task.authorizationMessageId === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["authorizationMessageId"],
        message: "authorized operations require their evidence message",
      });
    }

    if (task.dueBasis === "none" && task.dueAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["dueAt"],
        message: "dueAt must be null when dueBasis is none",
      });
    }

    if (task.dueBasis !== "none" && task.dueAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["dueAt"],
        message: "dueAt is required when dueBasis is not none",
      });
    }
  });

export const memoryNodeTypeSchema = z.enum([
  "note",
  "project",
  "person",
  "group",
  "task",
  "decision",
  "procedure",
  "reference",
  "entity",
  "daily_summary",
  "weekly_review",
  "consolidated_summary",
]);

export const memoryRelationSchema = z
  .object({
    type: z.string().trim().min(1).max(100),
    targetNodeType: memoryNodeTypeSchema,
    targetTitle: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const aiMemorySchema = z
  .object({
    operation: z.enum(["upsert", "ignore"]),
    nodeType: memoryNodeTypeSchema,
    title: z.string().trim().min(1).max(240),
    generatedContent: z.string().trim().max(8_000).nullable(),
    aliases: z.array(z.string().trim().min(1).max(160)).max(20),
    tags: z.array(z.string().trim().min(1).max(80)).max(30),
    confidence: z.number().min(0).max(1),
    sourceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
    relations: z.array(memoryRelationSchema).max(30),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((memory, ctx) => {
    if (memory.operation === "upsert" && !memory.generatedContent) {
      ctx.addIssue({
        code: "custom",
        path: ["generatedContent"],
        message: "generatedContent is required for an upsert memory",
      });
    }
    if (memory.operation === "ignore" && memory.generatedContent !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["generatedContent"],
        message: "generatedContent must be null for an ignored memory",
      });
    }
  });

const noReplySchema = z
  .object({
    needed: z.literal(false),
    recipientName: z.null(),
    recipientJid: z.null(),
    objective: z.literal("none"),
    draft: z.null(),
    tone: z.null(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const replySchema = z
  .object({
    needed: z.literal(true),
    recipientName: nullableTrimmedText(160),
    recipientJid: nullableTrimmedText(256),
    objective: z.enum([
      "acknowledge",
      "ask_missing_information",
      "confirm_deadline",
      "follow_up",
      "answer",
    ]),
    draft: z.string().trim().min(1).max(4_000),
    tone: z.string().trim().min(1).max(80),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const replyObjectiveValues = [
  "acknowledge",
  "ask_missing_information",
  "confirm_deadline",
  "follow_up",
  "answer",
] as const;

/**
 * Normaliza o objeto `reply` antes da validação estrita. O modelo às vezes
 * devolve um `reply` levemente fora do contrato (ex.: `needed:false` com um
 * `objective` do enum, ou `needed:true` sem `draft`/`tone`). Como a resposta é
 * apenas uma sugestão mostrada ao dono da conta — nunca enviada sozinha — um
 * `reply` malformado NÃO deve derrubar todo o triage (que também extrai
 * tarefas, compromissos e memórias). Aqui reduzimos qualquer forma inválida ao
 * caso canônico "sem resposta", preservando um reply bem-formado quando existe.
 */
export const aiReplySchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  const draft = typeof raw.draft === "string" ? raw.draft.trim() : "";
  const tone = typeof raw.tone === "string" ? raw.tone.trim() : "";
  const objectiveValid = replyObjectiveValues.includes(raw.objective as never);
  const wantsReply = raw.needed === true || raw.needed === "true";
  const wellFormed = wantsReply && draft.length > 0 && tone.length > 0 && objectiveValid;
  if (!wellFormed) {
    return {
      needed: false,
      recipientName: null,
      recipientJid: null,
      objective: "none",
      draft: null,
      tone: null,
      confidence,
    };
  }
  return {
    needed: true,
    recipientName: typeof raw.recipientName === "string" ? raw.recipientName : null,
    recipientJid: typeof raw.recipientJid === "string" ? raw.recipientJid : null,
    objective: raw.objective,
    draft,
    tone,
    confidence,
  };
}, z.discriminatedUnion("needed", [noReplySchema, replySchema]));

export const conversationIntentSchema = z.enum([
  "actionable",
  "follow_up",
  "question",
  "status_update",
  "informational",
  "social",
  "unknown",
]);

export const commitmentDirectionSchema = z.enum(["owed_by_me", "owed_to_me"]);
export const commitmentOperationSchema = z.enum(["create", "update", "fulfill", "cancel", "reopen"]);
export const aiCommitmentSchema = z
  .object({
    clientRef: z.string().trim().min(1).max(80),
    operation: commitmentOperationSchema.default("create"),
    authorization: taskAuthorizationSchema.default("inferred"),
    authorizationMessageId: nullableTrimmedText(256).default(null),
    commitmentId: nullableTrimmedText(128).default(null),
    direction: commitmentDirectionSchema,
    title: z.string().trim().min(1).max(240),
    counterparty: nullableTrimmedText(240),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    nextFollowUpAt: z.iso.datetime({ offset: true }).nullable().default(null),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
  })
  .strict()
  .superRefine((commitment, ctx) => {
    if (commitment.operation !== "create" && !commitment.commitmentId) {
      ctx.addIssue({ code: "custom", path: ["commitmentId"], message: "commitmentId is required for updates" });
    }
    if (commitment.operation === "create" && commitment.commitmentId !== null) {
      ctx.addIssue({ code: "custom", path: ["commitmentId"], message: "commitmentId must be null when creating" });
    }
  });

export const commitmentCandidateSchema = z.object({
  id: z.string().trim().min(1).max(128),
  direction: commitmentDirectionSchema,
  title: z.string().trim().min(1).max(300),
  counterparty: nullableTrimmedText(240),
  status: z.enum(["open", "waiting", "fulfilled", "cancelled"]),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  nextFollowUpAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type CommitmentCandidate = z.infer<typeof commitmentCandidateSchema>;

export const aiReminderSchema = z
  .object({
    clientRef: z.string().trim().min(1).max(80),
    taskClientRef: nullableTrimmedText(80),
    title: z.string().trim().min(1).max(240),
    scheduledAt: z.iso.datetime({ offset: true }),
    recurrence: nullableTrimmedText(300),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
  })
  .strict();

export const learningScopeSchema = z.enum(["global", "conversation", "person", "project"]);
export const learningRiskSchema = z.enum(["low", "high"]);
export const aiLearningSchema = z
  .object({
    clientRef: z.string().trim().min(1).max(80),
    scope: learningScopeSchema,
    scopeRef: nullableTrimmedText(240),
    statement: z.string().trim().min(1).max(2_000),
    explicitInstruction: z.boolean(),
    risk: learningRiskSchema,
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
  })
  .strict();

export const actionProposalSchema = z
  .object({
    clientRef: z.string().trim().min(1).max(80),
    kind: z.enum(["complete_task", "cancel_task", "merge_tasks", "profile_change"]),
    title: z.string().trim().min(1).max(240),
    targetIds: z.array(z.string().trim().min(1).max(128)).max(20),
    reversible: z.boolean(),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const conversationClassificationSchema = z
  .object({
    groupId: z.string().trim().min(1).max(128),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(600),
    evidenceMessageIds: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
  })
  .strict();

export const aiDecisionSchema = z
  .object({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    promptVersion: z.literal(AI_PROMPT_VERSION),
    conversationIntent: conversationIntentSchema,
    tasks: z.array(aiTaskSchema).max(10),
    reminders: z.array(aiReminderSchema).max(20).default([]),
    commitments: z.array(aiCommitmentSchema).max(20).default([]),
    learnings: z.array(aiLearningSchema).max(20).default([]),
    actionProposals: z.array(actionProposalSchema).max(20).default([]),
    conversationClassification: conversationClassificationSchema.nullable().optional(),
    memories: z.array(aiMemorySchema).max(20),
    reply: aiReplySchema,
    conversationSummary: z.string().trim().min(1).max(4_000),
    briefReason: z.string().trim().min(1).max(600),
  })
  .strict();

export type AiTask = z.infer<typeof aiTaskSchema>;
export type AiReminder = z.infer<typeof aiReminderSchema>;
export type AiCommitment = z.infer<typeof aiCommitmentSchema>;
export type AiLearning = z.infer<typeof aiLearningSchema>;
export type ActionProposal = z.infer<typeof actionProposalSchema>;
export type ConversationClassification = z.infer<typeof conversationClassificationSchema>;
export type AiMemory = z.infer<typeof aiMemorySchema>;
export type AiReply = z.infer<typeof aiReplySchema>;
export type AiDecision = z.infer<typeof aiDecisionSchema>;

export const normalizedMessageSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    userId: z.string().trim().min(1).max(128),
    chatJid: z.string().trim().min(1).max(256),
    senderJid: z.string().trim().min(1).max(256),
    senderName: nullableTrimmedText(160),
    sentAt: z.iso.datetime({ offset: true }),
    fromMe: z.boolean(),
    text: z.string().trim().min(1).max(32_000),
    isGroup: z.boolean().optional(),
    mentionedJids: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    quotedParticipantJid: nullableTrimmedText(256).optional(),
    quotedMessageId: nullableTrimmedText(256).optional(),
    directedToUser: z.boolean().optional(),
  })
  .strict();

export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

export const cardCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(500),
    description: z.string().max(8_000),
    listName: z.string().trim().min(1).max(200),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    url: z.url().nullable(),
    canonicalTaskId: nullableTrimmedText(128).default(null),
  })
  .strict();

export type CardCandidate = z.infer<typeof cardCandidateSchema>;

export const knownMemorySchema = z
  .object({
    nodeType: memoryNodeTypeSchema,
    title: z.string().trim().min(1).max(240),
    content: z.string().trim().min(1).max(8_000),
    aliases: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  })
  .strict();

export type KnownMemory = z.infer<typeof knownMemorySchema>;

export const aiCorrectionSchema = z
  .object({
    action: z.string().trim().min(1).max(80),
    comment: z.string().trim().max(2_000),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type AiCorrection = z.infer<typeof aiCorrectionSchema>;

export const activeLearningSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    scope: learningScopeSchema,
    scopeRef: nullableTrimmedText(240),
    statement: z.string().trim().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    explicitInstruction: z.boolean(),
  })
  .strict();
export type ActiveLearning = z.infer<typeof activeLearningSchema>;

export const conversationGroupCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
  })
  .strict();
export type ConversationGroupCandidate = z.infer<typeof conversationGroupCandidateSchema>;

export const conversationClassificationContextSchema = z
  .object({
    eligible: z.boolean(),
    messageCount: z.number().int().min(0),
    currentGroupId: z.string().trim().min(1).max(128).nullable(),
    currentSource: z.enum(["manual", "ai"]).nullable(),
  })
  .strict();
export type ConversationClassificationContext = z.infer<typeof conversationClassificationContextSchema>;

export const aiPreferencesSchema = z
  .object({
    language: z.string().trim().min(2).max(40).default("pt-BR"),
    timezone: z.string().trim().min(1).max(100).default("America/Sao_Paulo"),
    replyTone: z.string().trim().min(1).max(80).default("claro e profissional"),
    customInstructions: z.string().trim().max(4_000).default(""),
    processOwnMessagesWithPrefix: z.string().trim().min(1).max(40).default("trello:"),
  })
  .strict();

export type AiPreferences = z.infer<typeof aiPreferencesSchema>;

export interface AiContext {
  now: string;
  chatJid: string;
  chatName: string | null;
  previousSummary: string | null;
  preferences: AiPreferences;
  messages: NormalizedMessage[];
  isGroupChat?: boolean;
  ownerIdentity?: { jids: string[]; names: string[] };
  memories: KnownMemory[];
  corrections: AiCorrection[];
  activeLearnings: ActiveLearning[];
  cardCandidates: CardCandidate[];
  commitmentCandidates: CommitmentCandidate[];
  conversationGroups?: ConversationGroupCandidate[];
  conversationClassification?: ConversationClassificationContext;
  allowedListKeys: string[];
  allowedTrelloMemberIds: string[];
  isSelfChat: boolean;
}
