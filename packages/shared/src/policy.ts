import { DEFAULT_AI_CONFIDENCE_THRESHOLD, DEFAULT_MEMORY_CONFIDENCE_THRESHOLD } from "./constants.js";
import type { AiCommitment, AiContext, AiDecision, AiMemory, AiTask } from "./schemas.js";

export type TaskDisposition = "execute" | "review" | "propose" | "ignore";

export interface PlannedTask {
  task: AiTask;
  disposition: TaskDisposition;
  reason: string;
}

export interface AiExecutionPlan {
  tasks: PlannedTask[];
  acceptedMemories: AiMemory[];
  replyShouldNotifySelf: boolean;
}

export function canExecuteCommitmentMutation(commitment: AiCommitment, context?: AiContext): boolean {
  if (!['fulfill', 'cancel'].includes(commitment.operation)) return true;
  if (commitment.authorization === 'confirmed_proposal') return true;
  if (commitment.authorization !== 'explicit_user_command' || context?.isSelfChat !== true) return false;
  return context.messages.some((message) =>
    message.id === commitment.authorizationMessageId && message.fromMe,
  );
}

const DESTRUCTIVE_OPERATIONS = new Set<AiTask["operation"]>(["complete", "cancel", "merge"]);

export function isEvidenceDirectedToUser(context: AiContext | undefined, evidenceMessageIds: readonly string[]): boolean {
  if (!context) return true;
  const isGroup = context.isGroupChat ?? context.chatJid.endsWith("@g.us");
  if (!isGroup) return true;
  const evidence = new Set(evidenceMessageIds);
  return context.messages.some((message) => evidence.has(message.id) && (message.fromMe || message.directedToUser));
}

export function isTextAddressedToOwner(text: string, ownerNames: readonly string[]): boolean {
  const normalizedText = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("pt-BR");
  return ownerNames.some((rawName) => {
    const normalizedName = rawName.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("pt-BR");
    if (!normalizedName) return false;
    const variants = [...new Set([normalizedName, normalizedName.split(/\s+/)[0]].filter(Boolean))];
    return variants.some((name) =>
      normalizedText === name
      || normalizedText.startsWith(`${name},`)
      || normalizedText.startsWith(`${name}:`)
      || normalizedText.startsWith(`@${name} `)
      || normalizedText.startsWith(`@${name},`)
      || normalizedText.startsWith(`@${name}:`),
    );
  });
}

export function findInvalidDecisionReferences(
  decision: AiDecision,
  context: AiContext,
): string[] {
  const messageIds = new Set(context.messages.map((message) => message.id));
  const cardIds = new Set(context.cardCandidates.map((card) => card.id));
  const canonicalTaskIds = new Set(context.cardCandidates.flatMap((card) => card.canonicalTaskId ? [card.canonicalTaskId] : []));
  const memberIds = new Set(context.allowedTrelloMemberIds);
  const commitmentIds = new Set((context.commitmentCandidates ?? []).map((item) => item.id));
  const conversationGroupIds = new Set((context.conversationGroups ?? []).map((item) => item.id));
  const allowedTargetIds = new Set([
    ...messageIds,
    ...cardIds,
    ...context.cardCandidates.flatMap((card) => card.canonicalTaskId ? [card.canonicalTaskId] : []),
  ]);
  const taskClientRefs = new Set(decision.tasks.map((task) => task.clientRef));
  const issues: string[] = [];
  if (decision.conversationClassification) {
    if (context.conversationClassification?.eligible !== true) {
      issues.push("conversation classification was returned for an ineligible chat");
    }
    if (!conversationGroupIds.has(decision.conversationClassification.groupId)) {
      issues.push(`conversation classification references unknown group ${decision.conversationClassification.groupId}`);
    }
    for (const id of decision.conversationClassification.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`conversation classification references unknown message ${id}`);
    }
  }
  for (const task of decision.tasks) {
    for (const id of task.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`task ${task.clientRef} references unknown message ${id}`);
    }
    if (task.candidateCardId !== null && !cardIds.has(task.candidateCardId)) {
      issues.push(`task ${task.clientRef} references unknown card ${task.candidateCardId}`);
    }
    if (task.canonicalTaskId !== null && !canonicalTaskIds.has(task.canonicalTaskId)) {
      issues.push(`task ${task.clientRef} references unknown canonical task ${task.canonicalTaskId}`);
    }
    for (const cardId of task.mergeSourceCardIds) {
      if (!cardIds.has(cardId)) {
        issues.push(`task ${task.clientRef} references unknown merge source ${cardId}`);
      }
    }
    for (const memberId of [...(task.memberIdsToAdd ?? []), ...(task.memberIdsToRemove ?? [])]) {
      if (!memberIds.has(memberId)) {
        issues.push(`task ${task.clientRef} references unknown Trello member ${memberId}`);
      }
    }
    if (
      task.authorizationMessageId !== null &&
      !messageIds.has(task.authorizationMessageId)
    ) {
      issues.push(`task ${task.clientRef} references unknown authorization message ${task.authorizationMessageId}`);
    }
  }
  for (const reminder of decision.reminders) {
    for (const id of reminder.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`reminder ${reminder.clientRef} references unknown message ${id}`);
    }
    if (reminder.taskClientRef !== null && !taskClientRefs.has(reminder.taskClientRef)) {
      issues.push(`reminder ${reminder.clientRef} references unknown task clientRef ${reminder.taskClientRef}`);
    }
  }
  for (const commitment of decision.commitments) {
    for (const id of commitment.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`commitment ${commitment.clientRef} references unknown message ${id}`);
    }
    if (commitment.commitmentId !== null && !commitmentIds.has(commitment.commitmentId)) {
      issues.push(`commitment ${commitment.clientRef} references unknown commitment ${commitment.commitmentId}`);
    }
    if (commitment.authorizationMessageId !== null && !messageIds.has(commitment.authorizationMessageId)) {
      issues.push(`commitment ${commitment.clientRef} references unknown authorization message ${commitment.authorizationMessageId}`);
    }
  }
  for (const learning of decision.learnings) {
    for (const id of learning.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`learning ${learning.clientRef} references unknown message ${id}`);
    }
  }
  for (const proposal of decision.actionProposals) {
    for (const id of proposal.evidenceMessageIds) {
      if (!messageIds.has(id)) issues.push(`proposal ${proposal.clientRef} references unknown message ${id}`);
    }
    for (const targetId of proposal.targetIds) {
      if (!allowedTargetIds.has(targetId)) {
        issues.push(`proposal ${proposal.clientRef} references unknown target ${targetId}`);
      }
    }
  }
  for (const memory of decision.memories) {
    for (const id of memory.sourceMessageIds) {
      if (!messageIds.has(id)) issues.push(`memory ${memory.title} references unknown message ${id}`);
    }
  }
  return issues;
}

export function classifyTask(
  task: AiTask,
  confidenceThreshold = DEFAULT_AI_CONFIDENCE_THRESHOLD,
  context?: AiContext,
): PlannedTask {
  if (task.operation === "ignore") {
    return { task, disposition: "ignore", reason: "model_marked_ignore" };
  }
  if (!isEvidenceDirectedToUser(context, task.evidenceMessageIds)) {
    return { task, disposition: "ignore", reason: "group_message_not_directed_to_user" };
  }
  if (task.missingInformation.length > 0 || task.confidence < confidenceThreshold) {
    return { task, disposition: "review", reason: "low_confidence_or_missing_information" };
  }
  if (DESTRUCTIVE_OPERATIONS.has(task.operation)) {
    const authorizationMessage = task.authorizationMessageId
      ? context?.messages.find((message) => message.id === task.authorizationMessageId)
      : undefined;
    const explicitAuthorization =
      task.authorization === "confirmed_proposal" ||
      (task.authorization === "explicit_user_command" &&
        context?.isSelfChat === true &&
        authorizationMessage?.fromMe === true);
    if (!explicitAuthorization) {
      return { task, disposition: "propose", reason: "destructive_action_requires_confirmation" };
    }
  }
  return { task, disposition: "execute", reason: "confidence_threshold_met" };
}

export function buildAiExecutionPlan(
  decision: AiDecision,
  confidenceThreshold = DEFAULT_AI_CONFIDENCE_THRESHOLD,
  context?: AiContext,
  memoryConfidenceThreshold = DEFAULT_MEMORY_CONFIDENCE_THRESHOLD,
): AiExecutionPlan {
  return {
    tasks: decision.tasks.map((task) => classifyTask(task, confidenceThreshold, context)),
    acceptedMemories: decision.memories.filter(
      (memory) =>
        memory.operation === "upsert" && memory.confidence >= memoryConfidenceThreshold,
    ),
    replyShouldNotifySelf:
      decision.reply.needed && decision.reply.confidence >= confidenceThreshold,
  };
}
