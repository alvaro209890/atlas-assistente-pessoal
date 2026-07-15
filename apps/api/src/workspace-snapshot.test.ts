import { describe, expect, it } from 'vitest';

import { renderWorkspaceSnapshot } from './ai.js';

describe('renderWorkspaceSnapshot', () => {
  it('inclui tarefas, lembretes, compromissos, aprendizados e resumo', () => {
    const text = renderWorkspaceSnapshot({
      tasks: [{ title: 'Enviar orçamento', status: 'open', priority: 'high', dueAt: '2026-07-15T12:00:00Z', project: 'Aurora' }],
      reminders: [{ title: 'Ligar para o contador', scheduledFor: '2026-07-15T09:00:00Z', recurrence: null }],
      commitments: [{ title: 'Devolver contrato', direction: 'owed_by_me', counterpart: 'João', dueAt: null }],
      learnings: ['Prefere resumos curtos pela manhã'],
      latestSummary: 'Dia focado no lançamento.',
    });
    expect(text).toContain('Enviar orçamento');
    expect(text).toContain('prioridade: high');
    expect(text).toContain('Ligar para o contador');
    expect(text).toContain('Você prometeu: Devolver contrato (com João)');
    expect(text).toContain('Prefere resumos curtos pela manhã');
    expect(text).toContain('Dia focado no lançamento.');
  });

  it('devolve um marcador claro quando não há nada', () => {
    expect(renderWorkspaceSnapshot({ tasks: [], reminders: [], commitments: [], learnings: [], latestSummary: null }))
      .toBe('(espaço de trabalho vazio)');
  });
});
