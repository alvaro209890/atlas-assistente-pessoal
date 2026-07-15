import type {
  AiContext,
  AiCorrection,
  ActiveLearning,
  AiPreferences,
  CardCandidate,
  CommitmentCandidate,
  ConversationClassificationContext,
  ConversationGroupCandidate,
  KnownMemory,
  NormalizedMessage,
} from "./schemas.js";
import { DEFAULT_AI_CONTEXT_MAX_CHARS, DEFAULT_AI_CONTEXT_MAX_MESSAGES } from "./constants.js";

export interface BuildAiContextInput {
  now: Date;
  chatJid: string;
  chatName?: string | null;
  previousSummary?: string | null;
  preferences?: Partial<AiPreferences>;
  messages: NormalizedMessage[];
  ownerIdentity?: { jids?: string[]; names?: string[] };
  memories?: KnownMemory[];
  corrections?: AiCorrection[];
  activeLearnings?: ActiveLearning[];
  cardCandidates?: CardCandidate[];
  commitmentCandidates?: CommitmentCandidate[];
  conversationGroups?: ConversationGroupCandidate[];
  conversationClassification?: Partial<ConversationClassificationContext>;
  allowedListKeys?: string[];
  allowedTrelloMemberIds?: string[];
  maxRecentMessages?: number;
  maxContextChars?: number;
  maxMemories?: number;
  maxCorrections?: number;
  maxActiveLearnings?: number;
  maxCardCandidates?: number;
  isSelfChat?: boolean;
  isGroupChat?: boolean;
}

const DEFAULT_PREFERENCES: AiPreferences = {
  language: "pt-BR",
  timezone: "America/Sao_Paulo",
  replyTone: "claro e profissional",
  customInstructions: "",
  processOwnMessagesWithPrefix: "trello:",
};

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit < 80) return `${value.slice(0, Math.max(0, limit - 1))}…`;
  const head = Math.floor((limit - 1) * 0.7);
  return `${value.slice(0, head)}…${value.slice(-(limit - head - 1))}`;
}

function fitMessages(messages: readonly NormalizedMessage[], characterBudget: number): NormalizedMessage[] {
  const selected: NormalizedMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const overhead = 180;
    const remaining = characterBudget - used - overhead;
    if (remaining < 80 && selected.length > 0) break;
    const text = clipText(message.text, Math.min(1_200, Math.max(80, remaining)));
    selected.push({ ...message, text });
    used += overhead + text.length;
  }
  return selected.reverse();
}

function fitTextItems<T>(
  items: readonly T[],
  characterBudget: number,
  textOf: (item: T) => string,
  replaceText: (item: T, text: string) => T,
): T[] {
  const result: T[] = [];
  let used = 0;
  for (const item of items) {
    const remaining = characterBudget - used;
    if (remaining < 80 && result.length > 0) break;
    const text = clipText(textOf(item), Math.min(900, Math.max(80, remaining)));
    result.push(replaceText(item, text));
    used += text.length + 100;
  }
  return result;
}

function fitMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(metadata).length <= 500 ? metadata : { truncated: true };
}

export function buildAiContext(input: BuildAiContextInput): AiContext {
  // O worker pode montar lotes de até 30 mensagens. Nunca descartamos a
  // primeira metade do lote antes de a IA ter oportunidade de analisá-la.
  const maxRecentMessages = Math.min(input.maxRecentMessages ?? DEFAULT_AI_CONTEXT_MAX_MESSAGES, 30);
  const maxContextChars = Math.max(6_000, Math.min(input.maxContextChars ?? DEFAULT_AI_CONTEXT_MAX_CHARS, 40_000));
  const maxMemories = Math.min(input.maxMemories ?? 12, 14);
  const maxCorrections = Math.min(input.maxCorrections ?? 8, 12);
  const maxActiveLearnings = Math.min(input.maxActiveLearnings ?? 10, 10);
  const maxCardCandidates = Math.min(input.maxCardCandidates ?? 8, 8);
  const preferences: AiPreferences = {
    ...DEFAULT_PREFERENCES,
    ...input.preferences,
  };

  // Incluímos SEMPRE as mensagens do próprio dono como contexto da conversa: o
  // campo `from_me` identifica quem falou, então a IA enxerga os dois lados do
  // diálogo, entende o que já foi respondido e detecta compromissos que o
  // próprio dono assume ("te envio amanhã"). O prefixo
  // `processOwnMessagesWithPrefix` deixa de filtrar o contexto (segue existindo
  // apenas por compatibilidade de configuração).
  const eligibleMessages = [...input.messages];

  const sortedMessages = [...eligibleMessages]
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-maxRecentMessages);
  const messages = fitMessages(sortedMessages, Math.floor(maxContextChars * 0.56));
  const memories = fitTextItems(
    [...(input.memories ?? [])].slice(0, maxMemories),
    Math.floor(maxContextChars * 0.24),
    (memory) => memory.content,
    (memory, content) => ({ ...memory, content }),
  );
  const corrections = fitTextItems(
    [...(input.corrections ?? [])].slice(0, maxCorrections),
    Math.floor(maxContextChars * 0.1),
    (correction) => correction.comment,
    (correction, comment) => ({ ...correction, comment, metadata: fitMetadata(correction.metadata) }),
  );

  return {
    now: input.now.toISOString(),
    chatJid: input.chatJid,
    chatName: input.chatName ?? null,
    previousSummary: input.previousSummary ? clipText(input.previousSummary, 1_200) : null,
    preferences,
    messages,
    isGroupChat: input.isGroupChat ?? input.chatJid.endsWith("@g.us"),
    ownerIdentity: {
      jids: [...new Set(input.ownerIdentity?.jids ?? [])],
      names: [...new Set((input.ownerIdentity?.names ?? []).map((name) => name.trim()).filter(Boolean))],
    },
    memories,
    corrections,
    activeLearnings: [...(input.activeLearnings ?? [])].slice(0, maxActiveLearnings).map((learning) => ({
      ...learning, statement: clipText(learning.statement, 500),
    })),
    cardCandidates: [...(input.cardCandidates ?? [])].slice(0, maxCardCandidates).map((card) => ({
      ...card, description: clipText(card.description, 600),
    })),
    commitmentCandidates: [...(input.commitmentCandidates ?? [])].slice(0, 12),
    conversationGroups: (input.conversationGroups ?? []).slice(0, 30).map((group) => ({
      ...group, description: clipText(group.description, 240),
    })),
    conversationClassification: {
      eligible: input.conversationClassification?.eligible ?? false,
      messageCount: input.conversationClassification?.messageCount ?? 0,
      currentGroupId: input.conversationClassification?.currentGroupId ?? null,
      currentSource: input.conversationClassification?.currentSource ?? null,
    },
    allowedListKeys: [...new Set(input.allowedListKeys ?? [])],
    allowedTrelloMemberIds: [...new Set(input.allowedTrelloMemberIds ?? [])],
    isSelfChat: input.isSelfChat ?? false,
  };
}

export function serializeAiContext(context: AiContext): string {
  return JSON.stringify({
    current_datetime: context.now,
    timezone: context.preferences.timezone,
    language: context.preferences.language,
    reply_tone: context.preferences.replyTone,
    user_instructions: context.preferences.customInstructions,
    chat: { jid: context.chatJid, name: context.chatName },
    is_group_chat: context.isGroupChat ?? context.chatJid.endsWith("@g.us"),
    owner_identity: context.ownerIdentity ?? { jids: [], names: [] },
    previous_summary: context.previousSummary,
    known_memories: context.memories,
    previous_corrections: context.corrections,
    active_learnings: context.activeLearnings,
    is_self_chat: context.isSelfChat,
    allowed_list_keys: context.allowedListKeys,
    allowed_trello_member_ids: context.allowedTrelloMemberIds,
    candidate_cards: context.cardCandidates,
    candidate_commitments: context.commitmentCandidates,
    conversation_groups: context.conversationGroups ?? [],
    classification_state: context.conversationClassification ?? {
      eligible: false, messageCount: 0, currentGroupId: null, currentSource: null,
    },
    messages: context.messages.map((message) => ({
      id: message.id,
      sender_jid: message.senderJid,
      sender_name: message.senderName,
      sent_at: message.sentAt,
      from_me: message.fromMe,
      is_group: message.isGroup ?? message.chatJid.endsWith("@g.us"),
      mentioned_jids: message.mentionedJids ?? [],
      quoted_participant_jid: message.quotedParticipantJid ?? null,
      quoted_message_id: message.quotedMessageId ?? null,
      directed_to_user: message.directedToUser ?? !message.chatJid.endsWith("@g.us"),
      text: message.text,
    })),
  });
}
