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

export function buildAiContext(input: BuildAiContextInput): AiContext {
  const maxRecentMessages = Math.min(input.maxRecentMessages ?? 15, 15);
  const maxMemories = Math.min(input.maxMemories ?? 8, 10);
  const maxCorrections = Math.min(input.maxCorrections ?? 8, 12);
  const maxActiveLearnings = Math.min(input.maxActiveLearnings ?? 6, 6);
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

  return {
    now: input.now.toISOString(),
    chatJid: input.chatJid,
    chatName: input.chatName ?? null,
    previousSummary: input.previousSummary ?? null,
    preferences,
    messages: sortedMessages,
    isGroupChat: input.isGroupChat ?? input.chatJid.endsWith("@g.us"),
    ownerIdentity: {
      jids: [...new Set(input.ownerIdentity?.jids ?? [])],
      names: [...new Set((input.ownerIdentity?.names ?? []).map((name) => name.trim()).filter(Boolean))],
    },
    memories: [...(input.memories ?? [])].slice(0, maxMemories),
    corrections: [...(input.corrections ?? [])].slice(0, maxCorrections),
    activeLearnings: [...(input.activeLearnings ?? [])].slice(0, maxActiveLearnings),
    cardCandidates: [...(input.cardCandidates ?? [])].slice(0, maxCardCandidates),
    commitmentCandidates: [...(input.commitmentCandidates ?? [])].slice(0, 12),
    conversationGroups: [...(input.conversationGroups ?? [])].slice(0, 30),
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
