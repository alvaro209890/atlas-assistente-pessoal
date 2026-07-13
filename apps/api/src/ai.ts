import { z } from 'zod';

export interface AiSource {
  id: string;
  title: string;
  excerpt: string;
  kind: 'note' | 'whatsapp' | 'trello';
  updatedAt: string;
}

export interface AiPrompt {
  message: string;
  sources: AiSource[];
  conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile?: {
    preferredName: string;
    fullName: string | null;
    occupation: string | null;
    goals: string[];
    timezone: string;
    locale: string;
    workDays: number[];
    workStart: string;
    workEnd: string;
    communicationStyle: string;
  };
}

export interface AiAnswer {
  answer: string;
  provider: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
  };
}

export interface AiProvider {
  answer(prompt: AiPrompt, signal?: AbortSignal): Promise<AiAnswer>;
}

const deepseekResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().int().nonnegative().optional(),
    }).optional(),
  }).optional(),
});

export function invalidCitationNumbers(answer: string, sourceCount: number): number[] {
  return [...new Set(
    [...answer.matchAll(/\[(\d+)\]/g)]
      .map((match) => Number(match[1]))
      .filter((number) => !Number.isInteger(number) || number < 1 || number > sourceCount),
  )];
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider implements AiProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async answer(prompt: AiPrompt, signal?: AbortSignal): Promise<AiAnswer> {
    const context = prompt.sources.map((source, index) =>
      `[fonte ${index + 1} | id=${source.id} | ${source.kind}] ${source.title}\n${source.excerpt}`,
    ).join('\n\n');
    const profile = prompt.profile
      ? [
          `Nome preferido confirmado: ${prompt.profile.preferredName}`,
          prompt.profile.fullName ? `Nome completo: ${prompt.profile.fullName}` : null,
          prompt.profile.occupation ? `Área de atuação: ${prompt.profile.occupation}` : null,
          prompt.profile.goals.length ? `Objetivos: ${prompt.profile.goals.join('; ')}` : null,
          `Fuso e idioma: ${prompt.profile.timezone}; ${prompt.profile.locale}`,
          `Jornada: dias ${prompt.profile.workDays.join(', ')}, ${prompt.profile.workStart}–${prompt.profile.workEnd}`,
          `Estilo de comunicação: ${prompt.profile.communicationStyle}`,
        ].filter((line): line is string => line !== null).join('\n')
      : '(perfil pessoal não disponível)';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('AI request timeout')), this.options.timeoutMs);
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          reasoning_effort: 'high',
          thinking: { type: 'enabled' },
          messages: [
            {
              role: 'system',
              content: 'Você é Atlas, um assistente pessoal masculino, calmo, direto, humano e proativo. Explique prioridades sem ser invasivo. Responda em português claro. Use apenas o contexto fornecido para fatos pessoais e indique incertezas. Nunca atribua um nome à pessoa sem que ele esteja confirmado no perfil. Não afirme que executou uma ação: a interface apresentará propostas confirmáveis separadamente. Ao sustentar uma afirmação, cite as fontes como [1], [2] ... [N], usando exatamente o número que corresponde à ordem das fontes recebidas. Nunca invente um número de fonte.',
            },
            ...(prompt.conversation ?? []).slice(-8),
            {
              role: 'user',
              content: `Perfil confirmado da pessoa:\n${profile}\n\nPergunta:\n${prompt.message}\n\nContexto recuperado:\n${context || '(nenhum contexto recuperado)'}`,
            },
          ],
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`DeepSeek returned HTTP ${response.status}: ${detail}`);
      }
      const parsed = deepseekResponseSchema.parse(await response.json());
      const rawAnswer = parsed.choices[0]?.message.content?.trim();
      if (!rawAnswer) throw new Error('DeepSeek returned an empty answer');
      const invalidCitations = invalidCitationNumbers(rawAnswer, prompt.sources.length);
      if (invalidCitations.length) {
        throw new Error(`DeepSeek returned citations outside the supplied context: ${invalidCitations.join(', ')}`);
      }
      const hasCitation = /\[\d+\]/.test(rawAnswer);
      const answer = prompt.sources.length > 0 && !hasCitation
        ? `${rawAnswer}\n\nFontes consultadas: ${prompt.sources.map((_, index) => `[${index + 1}]`).join(', ')}`
        : rawAnswer;
      return {
        answer,
        provider: 'deepseek',
        model: parsed.model ?? this.options.model,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? parsed.usage?.reasoning_tokens ?? 0,
          cachedTokens: parsed.usage?.prompt_cache_hit_tokens ?? 0,
        },
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
