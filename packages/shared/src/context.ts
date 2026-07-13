import type {
  AiContext,
  AiCorrection,
  ActiveLearning,
  AiPreferences,
  CardCandidate,
  CommitmentCandidate,
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
  memories?: KnownMemory[];
  corrections?: AiCorrection[];
  activeLearnings?: ActiveLearning[];
  cardCandidates?: CardCandidate[];
  commitmentCandidates?: CommitmentCandidate[];
  allowedListKeys?: string[];
  allowedTrelloMemberIds?: string[];
  maxRecentMessages?: number;
  maxMemories?: number;
  maxCorrections?: number;
  maxActiveLearnings?: number;
  maxCardCandidates?: number;
  isSelfChat?: boolean;
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

  const eligibleMessages = input.messages.filter((message) => {
    if (!message.fromMe) return true;
    if (input.isSelfChat === true) return true;
    return message.text
      .toLocaleLowerCase(preferences.language)
      .startsWith(preferences.processOwnMessagesWithPrefix.toLocaleLowerCase(preferences.language));
  });

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
    memories: [...(input.memories ?? [])].slice(0, maxMemories),
    corrections: [...(input.corrections ?? [])].slice(0, maxCorrections),
    activeLearnings: [...(input.activeLearnings ?? [])].slice(0, maxActiveLearnings),
    cardCandidates: [...(input.cardCandidates ?? [])].slice(0, maxCardCandidates),
    commitmentCandidates: [...(input.commitmentCandidates ?? [])].slice(0, 12),
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
    previous_summary: context.previousSummary,
    known_memories: context.memories,
    previous_corrections: context.corrections,
    active_learnings: context.activeLearnings,
    is_self_chat: context.isSelfChat,
    allowed_list_keys: context.allowedListKeys,
    allowed_trello_member_ids: context.allowedTrelloMemberIds,
    candidate_cards: context.cardCandidates,
    candidate_commitments: context.commitmentCandidates,
    messages: context.messages.map((message) => ({
      id: message.id,
      sender_jid: message.senderJid,
      sender_name: message.senderName,
      sent_at: message.sentAt,
      from_me: message.fromMe,
      text: message.text,
    })),
  });
}
