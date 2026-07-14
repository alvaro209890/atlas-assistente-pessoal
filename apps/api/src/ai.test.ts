import { describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, invalidCitationNumbers } from './ai.js';

describe('DeepSeek provider', () => {
  it('rejects citation numbers that were not supplied to the model', () => {
    expect(invalidCitationNumbers('Use [1], não [4].', 2)).toEqual([4]);
    expect(invalidCitationNumbers('Sem referências.', 0)).toEqual([]);
  });

  it('always requests the configured V4 Flash model with medium reasoning and cited context', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: 'deepseek-v4-flash', reasoning_effort: 'medium', thinking: { type: 'enabled' },
      });
      expect(payload).not.toHaveProperty('temperature');
      expect(JSON.stringify(payload)).toContain('[fonte 1');
      expect(JSON.stringify(payload)).toContain('cite as fontes como [1]');
      expect(JSON.stringify(payload)).toContain('Nome preferido confirmado: Marina');
      expect(JSON.stringify(payload)).toContain('Objetivos: Organizar lançamentos');
      return new Response(JSON.stringify({
        model: 'deepseek-v4-flash',
        choices: [{ message: { content: 'A decisão foi registrada [1].' } }],
        usage: { prompt_tokens: 10, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const provider = new DeepSeekProvider({
      apiKey: 'server-only-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', timeoutMs: 5_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await provider.answer({
      message: 'Qual foi a decisão?',
      sources: [{ id: 'node-1', title: 'Decisões', excerpt: 'O lançamento será quinta.', kind: 'note', updatedAt: new Date().toISOString() }],
      profile: {
        preferredName: 'Marina', fullName: null, occupation: 'Produto',
        goals: ['Organizar lançamentos'], timezone: 'America/Sao_Paulo', locale: 'pt-BR',
        workDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '18:00', communicationStyle: 'balanced',
      },
    });
    expect(result.answer).toBe('A decisão foi registrada [1].');
    expect(result.usage.reasoningTokens).toBe(3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
